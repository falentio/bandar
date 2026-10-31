import * as v from "valibot";
import {
  toolResultText,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolParameters,
} from "../../../shared/conversation";
import { finishOf } from "../types";
import type { ReasoningEffort } from "../../../shared/reasoning";
import type { ProviderKind } from "../../../shared/providers";
import {
  joinUrl,
  postJson,
  protocolError,
  requireBody,
  requireOk,
  sseData,
  type HeaderFactory,
} from "../http";
import type {
  AdapterInput,
  CanonicalMessage,
  CanonicalResult,
  CanonicalStreamEvent,
  CanonicalUsage,
  ProviderAdapter,
} from "../types";

const UsageSchema = v.object({
  input_tokens: v.optional(v.nullable(v.number())),
  output_tokens: v.optional(v.nullable(v.number())),
  input_tokens_details: v.optional(
    v.nullable(v.object({ cached_tokens: v.optional(v.nullable(v.number())) })),
  ),
});

const ErrorSchema = v.object({ message: v.optional(v.string()) });

const OutputSchema = v.object({
  type: v.string(),
  content: v.optional(
    v.array(v.object({ type: v.string(), text: v.optional(v.nullable(v.string())) })),
  ),
  call_id: v.optional(v.nullable(v.string())),
  name: v.optional(v.nullable(v.string())),
  arguments: v.optional(v.nullable(v.string())),
});

type Output = v.InferOutput<typeof OutputSchema>;

const ResponseSchema = v.object({
  output: v.array(OutputSchema),
  status: v.optional(v.nullable(v.string())),
  incomplete_details: v.optional(
    v.nullable(v.object({ reason: v.optional(v.nullable(v.string())) })),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.nullable(ErrorSchema)),
});

const EventSchema = v.object({
  type: v.string(),
  delta: v.optional(v.nullable(v.string())),
  item: v.optional(v.nullable(OutputSchema)),
  output_index: v.optional(v.number()),
  response: v.optional(ResponseSchema),
  error: v.optional(ErrorSchema),
  message: v.optional(v.string()),
});

type InputMessage = {
  role: "system" | "user" | "assistant";
  content: { type: "input_text"; text: string }[];
};

type InputItem =
  | InputMessage
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ResponsesToolBody = {
  type: "function";
  name: string;
  description?: string;
  parameters: ToolParameters;
};

/** This wire spells a named tool choice flat, unlike the chat wire's nested function object. */
type ResponsesToolChoiceBody = { type: "function"; name: string };

type ResponsesBody = {
  model: string;
  input: InputItem[];
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: readonly ResponsesToolBody[];
  tool_choice?: string | ResponsesToolChoiceBody;
  reasoning?: { effort: ReasoningEffort };
};

export type ResponsesOptions<K extends ProviderKind> = {
  readonly kind: K;
  readonly label: string;
  readonly headers: HeaderFactory;
};

export function responsesAdapter<K extends ProviderKind>({
  kind,
  label,
  headers: headersOf,
}: ResponsesOptions<K>): ProviderAdapter<K> {
  return {
    kind,

    async chat(input: AdapterInput): Promise<CanonicalResult> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/responses"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, false)),
        signal: input.signal,
      });

      await requireOk(response);

      const parsed = v.safeParse(ResponseSchema, await response.json());

      if (!parsed.success) throw protocolError(`${label} returned an unexpected response shape`);

      const failure = failureOf(parsed.output, label);

      if (failure !== null) throw protocolError(failure);

      const calls = callsOf(parsed.output.output, label);

      return {
        text: textOf(parsed.output.output),
        toolCalls: calls,
        finishReason: finishOf(
          finishReason(parsed.output.status ?? null, reasonOf(parsed.output)),
          calls,
        ),
        usage: usageOf(parsed.output.usage),
      };
    },

    async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/responses"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, true)),
        signal: input.signal,
      });

      await requireOk(response);

      let reason: string | null = null;
      let usage: CanonicalUsage | null = null;
      const calls: ToolCall[] = [];
      const started = new Map<number, ToolCall>();
      const produced = new Set<number>();

      for await (const data of sseData(requireBody(response), input.signal)) {
        if (data === "[DONE]") break;

        const event = parseEvent(data);

        if (event === null) continue;

        switch (event.type) {
          case "response.output_text.delta": {
            if (event.delta !== undefined && event.delta !== null && event.delta !== "") {
              yield { type: "text", text: event.delta };
            }

            break;
          }

          case "response.output_item.added": {
            const item = event.item;

            if (item === undefined || item === null || item.type !== "function_call") break;

            const call = callOf(item, label);
            const index = event.output_index ?? 0;

            started.set(index, call);
            calls.push(call);

            yield { type: "tool_call_start", call };

            if (call.arguments !== "") {
              produced.add(index);
              yield { type: "tool_call_delta", id: call.id, arguments: call.arguments };
            }

            break;
          }

          case "response.function_call_arguments.delta": {
            const index = event.output_index ?? 0;
            const call = started.get(index);

            if (call === undefined)
              throw protocolError(label + " streamed arguments for a call it never announced");

            if (event.delta === undefined || event.delta === null || event.delta === "") break;

            produced.add(index);
            yield { type: "tool_call_delta", id: call.id, arguments: event.delta };
            break;
          }

          case "response.output_item.done": {
            const item = event.item;

            if (item === undefined || item === null || item.type !== "function_call") break;

            const index = event.output_index ?? 0;
            const known = started.get(index);

            // A provider that only sends the finished item still has to yield the call whole.
            if (known === undefined) {
              const call = callOf(item, label);

              started.set(index, call);
              calls.push(call);

              yield { type: "tool_call_start", call };

              if (call.arguments !== "") {
                produced.add(index);
                yield { type: "tool_call_delta", id: call.id, arguments: call.arguments };
              }

              break;
            }

            if (produced.has(index)) break;

            const final = item.arguments;

            if (final === undefined || final === null || final === "") break;

            produced.add(index);
            yield { type: "tool_call_delta", id: known.id, arguments: final };
            break;
          }

          case "response.completed":
          case "response.incomplete": {
            const result = event.response;

            if (result === undefined) break;

            if (result.usage !== undefined && result.usage !== null) {
              usage = usageOf(result.usage);
            }

            const status =
              result.status ?? (event.type === "response.completed" ? "completed" : "incomplete");

            reason = finishReason(status, reasonOf(result));
            break;
          }

          case "response.failed": {
            throw protocolError(event.response?.error?.message ?? `${label} stream failed`);
          }

          case "error": {
            throw protocolError(
              event.error?.message ?? event.message ?? `${label} stream returned an error`,
            );
          }

          default: {
            break;
          }
        }
      }

      if (usage !== null) yield { type: "usage", usage };

      yield { type: "finish", reason: finishOf(reason, calls) };
    },
  };
}

function bodyFor(input: AdapterInput, stream: boolean): ResponsesBody {
  const body: ResponsesBody = {
    model: input.target.upstreamModel,
    input: itemsOf(input.request.messages),
  };

  if (stream) body.stream = true;

  if (input.request.temperature !== undefined) body.temperature = input.request.temperature;

  if (input.request.topP !== undefined) body.top_p = input.request.topP;

  if (input.request.maxTokens !== undefined) body.max_output_tokens = input.request.maxTokens;

  if (input.request.tools.length > 0) body.tools = input.request.tools.map(toolBodyOf);

  if (input.request.toolChoice !== null) body.tool_choice = toolChoiceOf(input.request.toolChoice);

  if (input.request.reasoning?.kind === "effort")
    body.reasoning = { effort: input.request.reasoning.effort };

  return body;
}

/** A call and a result are items of their own here, so a turn becomes several in part order. */
function itemsOf(messages: readonly CanonicalMessage[]): InputItem[] {
  const items: InputItem[] = [];

  for (const message of messages) {
    let text: string[] = [];

    const flush = () => {
      if (text.length === 0) return;

      items.push({ role: message.role, content: [{ type: "input_text", text: text.join("\n") }] });
      text = [];
    };

    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          text.push(part.text);
          break;
        }

        case "tool_call": {
          flush();
          items.push({
            type: "function_call",
            call_id: part.call.id,
            name: part.call.name,
            arguments: part.call.arguments,
          });
          break;
        }

        case "tool_result": {
          flush();
          items.push({
            type: "function_call_output",
            call_id: part.result.toolCallId,
            output: toolResultText(part.result),
          });
          break;
        }
      }
    }

    flush();
  }

  return items;
}

function toolBodyOf(tool: ToolDefinition): ResponsesToolBody {
  const body: ResponsesToolBody = {
    type: "function",
    name: tool.name,
    parameters: tool.parameters,
  };

  if (tool.description !== null) body.description = tool.description;

  return body;
}

function toolChoiceOf(choice: ToolChoice): string | ResponsesToolChoiceBody {
  switch (choice.mode) {
    case "auto": {
      return "auto";
    }

    case "none": {
      return "none";
    }

    case "required": {
      return "required";
    }

    case "tool": {
      return { type: "function", name: choice.name };
    }
  }
}

function parseEvent(data: string): v.InferOutput<typeof EventSchema> | null {
  try {
    const parsed = v.safeParse(EventSchema, JSON.parse(data));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function callsOf(output: readonly Output[], label: string): readonly ToolCall[] {
  return output.flatMap((item) => (item.type === "function_call" ? [callOf(item, label)] : []));
}

function callOf(item: Output, label: string): ToolCall {
  if (item.call_id === undefined || item.call_id === null)
    throw protocolError(label + " returned a tool call with no call_id");

  if (item.name === undefined || item.name === null)
    throw protocolError(label + " returned a tool call with no name");

  return { id: item.call_id, name: item.name, arguments: item.arguments ?? "" };
}

function textOf(output: readonly Output[]): string {
  const parts: string[] = [];

  for (const item of output) {
    if (item.type !== "message") continue;

    for (const part of item.content ?? []) {
      if (part.type === "output_text") parts.push(part.text ?? "");
    }
  }

  return parts.join("");
}

function reasonOf(response: v.InferOutput<typeof ResponseSchema>): string | null {
  return response.incomplete_details?.reason ?? null;
}

/** A 200 is not a success on this wire: a failed response carries its error in the body. */
function failureOf(response: v.InferOutput<typeof ResponseSchema>, label: string): string | null {
  if (response.status === "failed") {
    return response.error?.message ?? `${label} returned a failed response`;
  }

  if (response.output.length > 0) return null;

  return response.error?.message ?? null;
}

function usageOf(usage: v.InferOutput<typeof UsageSchema> | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
  };
}

function finishReason(status: string | null, reason: string | null): string | null {
  if (status === "completed") return "stop";

  if (status === "incomplete" && reason === "max_output_tokens") return "length";

  return reason;
}
