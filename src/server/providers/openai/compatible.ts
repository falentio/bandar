import * as v from "valibot";
import {
  textOfParts,
  toolCallsOf,
  toolResultText,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolParameters,
} from "../../../shared/conversation";
import type { ProviderKind } from "../../../shared/providers";
import {
  bearerHeaders,
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
  prompt_tokens: v.optional(v.nullable(v.number())),
  completion_tokens: v.optional(v.nullable(v.number())),
});

const ResponseSchema = v.object({
  choices: v.array(
    v.object({
      message: v.object({ content: v.optional(v.nullable(v.string())) }),
      finish_reason: v.optional(v.nullable(v.string())),
    }),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
});

const ChunkSchema = v.object({
  choices: v.optional(
    v.array(
      v.object({
        delta: v.object({ content: v.optional(v.nullable(v.string())) }),
        finish_reason: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.object({ message: v.optional(v.string()) })),
});

export type ChatToolBody = {
  type: "function";
  function: { name: string; description?: string; parameters: ToolParameters };
};

type ChatToolChoiceBody = { type: "function"; function: { name: string } };

type ChatToolCallBody = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessageBody =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ChatToolCallBody[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatBody = {
  model: string;
  messages: ChatMessageBody[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: readonly string[];
  tools?: readonly ChatToolBody[];
  tool_choice?: string | ChatToolChoiceBody;
};

export type CompatibleOptions<K extends ProviderKind> = {
  readonly kind: K;
  readonly label: string;
  readonly headers: HeaderFactory;
};

export function chatAdapter<K extends ProviderKind>({
  kind,
  label,
  headers: headersOf,
}: CompatibleOptions<K>): ProviderAdapter<K> {
  return {
    kind,

    async chat(input: AdapterInput): Promise<CanonicalResult> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/chat/completions"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, false)),
        signal: input.signal,
      });

      await requireOk(response);

      const parsed = v.safeParse(ResponseSchema, await response.json());

      if (!parsed.success) throw protocolError(`${label} returned an unexpected response shape`);

      const choice = parsed.output.choices[0];

      if (choice === undefined) throw protocolError(`${label} returned no choices`);

      return {
        text: choice.message.content ?? "",
        toolCalls: [],
        finishReason: choice.finish_reason ?? null,
        usage: usageOf(parsed.output.usage),
      };
    },

    async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/chat/completions"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, true)),
        signal: input.signal,
      });

      await requireOk(response);

      let reason: string | null = null;
      let usage: CanonicalUsage | null = null;

      for await (const data of sseData(requireBody(response), input.signal)) {
        if (data === "[DONE]") break;

        const chunk = parseChunk(data);

        if (chunk === null) continue;

        if (chunk.error !== undefined) {
          throw protocolError(chunk.error.message ?? `${label} stream returned an error`);
        }

        if (chunk.usage !== undefined && chunk.usage !== null) usage = usageOf(chunk.usage);

        const choice = chunk.choices?.[0];

        if (choice === undefined) continue;

        if (
          choice.delta.content !== undefined &&
          choice.delta.content !== null &&
          choice.delta.content !== ""
        ) {
          yield { type: "text", text: choice.delta.content };
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          reason = choice.finish_reason;
        }
      }

      if (usage !== null) yield { type: "usage", usage };

      yield { type: "finish", reason };
    },
  };
}

export function bearerAdapter<K extends ProviderKind>(
  kind: K,
  label: string = kind,
): ProviderAdapter<K> {
  return chatAdapter({ kind, label, headers: bearerHeaders });
}

function bodyFor(input: AdapterInput, stream: boolean): ChatBody {
  const body: ChatBody = {
    model: input.target.upstreamModel,
    messages: messagesOf(input.request.messages),
    stream,
  };

  if (stream) body.stream_options = { include_usage: true };

  if (input.request.temperature !== undefined) body.temperature = input.request.temperature;

  if (input.request.topP !== undefined) body.top_p = input.request.topP;

  if (input.request.maxTokens !== undefined) body.max_tokens = input.request.maxTokens;

  if (input.request.stop !== undefined) body.stop = input.request.stop;

  if (input.request.tools.length > 0) body.tools = input.request.tools.map(toolBodyOf);

  if (input.request.toolChoice !== null) body.tool_choice = toolChoiceOf(input.request.toolChoice);

  return body;
}

/** One canonical turn becomes one message, or several: a result is its own role on this wire. */
function messagesOf(messages: readonly CanonicalMessage[]): ChatMessageBody[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? [assistantBody(message)] : flattenedBodies(message),
  );
}

function assistantBody(message: CanonicalMessage): ChatMessageBody {
  const calls = toolCallsOf(message.content);
  const body: ChatMessageBody = { role: "assistant", content: textOfParts(message.content) };

  if (calls.length > 0) body.tool_calls = calls.map(toolCallBody);

  return body;
}

/** A result splits the turn: this wire addresses one with a message of its own, at the part's position. */
function flattenedBodies(message: CanonicalMessage): ChatMessageBody[] {
  const bodies: ChatMessageBody[] = [];
  const role = message.role === "system" ? "system" : "user";
  let text: string[] = [];

  const flush = () => {
    if (text.length === 0) return;

    bodies.push({ role, content: text.join("\n") });
    text = [];
  };

  for (const part of message.content) {
    switch (part.type) {
      case "text": {
        text.push(part.text);
        break;
      }

      case "tool_result": {
        flush();
        bodies.push({
          role: "tool",
          tool_call_id: part.result.toolCallId,
          content: toolResultText(part.result),
        });
        break;
      }

      case "tool_call": {
        flush();
        bodies.push({ role: "assistant", content: "", tool_calls: [toolCallBody(part.call)] });
        break;
      }
    }
  }

  flush();

  return bodies;
}

function toolCallBody(call: ToolCall): ChatToolCallBody {
  return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
}

function toolBodyOf(tool: ToolDefinition): ChatToolBody {
  const fn: ChatToolBody["function"] = { name: tool.name, parameters: tool.parameters };

  if (tool.description !== null) fn.description = tool.description;

  return { type: "function", function: fn };
}

function toolChoiceOf(choice: ToolChoice): string | ChatToolChoiceBody {
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
      return { type: "function", function: { name: choice.name } };
    }
  }
}

function parseChunk(data: string): v.InferOutput<typeof ChunkSchema> | null {
  try {
    const parsed = v.safeParse(ChunkSchema, JSON.parse(data));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function usageOf(usage: v.InferOutput<typeof UsageSchema> | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
  };
}
