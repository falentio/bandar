import * as v from "valibot";
import {
  coalesceText,
  textOfParts,
  type MessagePart,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolParameters,
} from "../../../shared/conversation";
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
import {
  UpstreamError,
  finishOf,
  jsonObjectOf,
  type AdapterInput,
  type CanonicalMessage,
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUsage,
  type ProviderAdapter,
} from "../types";

const UsageSchema = v.object({
  input_tokens: v.optional(v.nullable(v.number())),
  output_tokens: v.optional(v.nullable(v.number())),
  cache_read_input_tokens: v.optional(v.nullable(v.number())),
  cache_creation_input_tokens: v.optional(v.nullable(v.number())),
});

type Usage = v.InferOutput<typeof UsageSchema>;

const ContentBlockSchema = v.object({
  type: v.string(),
  text: v.optional(v.nullable(v.string())),
  id: v.optional(v.nullable(v.string())),
  name: v.optional(v.nullable(v.string())),
  input: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
});

type ContentBlock = v.InferOutput<typeof ContentBlockSchema>;

const ResponseSchema = v.object({
  content: v.array(ContentBlockSchema),
  stop_reason: v.optional(v.nullable(v.string())),
  usage: v.optional(v.nullable(UsageSchema)),
});

const StreamSchema = v.object({
  type: v.string(),
  index: v.optional(v.number()),
  message: v.optional(v.object({ usage: v.optional(v.nullable(UsageSchema)) })),
  content_block: v.optional(ContentBlockSchema),
  delta: v.optional(
    v.object({
      type: v.optional(v.string()),
      text: v.optional(v.nullable(v.string())),
      partial_json: v.optional(v.nullable(v.string())),
      stop_reason: v.optional(v.nullable(v.string())),
    }),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.object({ message: v.optional(v.string()) })),
});

type RequestBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ToolParameters }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type MessageBody = { role: "user" | "assistant"; content: string | RequestBlock[] };

type AnthropicToolBody = {
  name: string;
  description?: string;
  input_schema: ToolParameters;
};

type AnthropicToolChoiceBody = { type: "auto" } | { type: "any" } | { type: "tool"; name: string };

type ChatBody = {
  model: string;
  messages: MessageBody[];
  max_tokens: number;
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: readonly AnthropicToolBody[];
  tool_choice?: AnthropicToolChoiceBody;
};

export type AnthropicOptions<K extends ProviderKind> = {
  readonly kind: K;
  readonly label: string;
  readonly headers: HeaderFactory;
};

export function anthropicAdapter<K extends ProviderKind>({
  kind,
  label,
  headers: headersOf,
}: AnthropicOptions<K>): ProviderAdapter<K> {
  return {
    kind,

    async chat(input: AdapterInput): Promise<CanonicalResult> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/messages"),
        headers: { "anthropic-version": "2023-06-01", ...headersOf(input.target.credential) },
        body: JSON.stringify(bodyFor(input, false)),
        signal: input.signal,
      });

      await requireOk(response);

      const parsed = v.safeParse(ResponseSchema, await response.json());

      if (!parsed.success) throw protocolError(`${label} returned an unexpected response shape`);

      const text = parsed.output.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");

      const calls = callsOf(parsed.output.content, label);

      return {
        text,
        toolCalls: calls,
        finishReason: finishOf(finishReason(parsed.output.stop_reason ?? null), calls),
        usage: usageOf(parsed.output.usage),
      };
    },

    async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/messages"),
        headers: { "anthropic-version": "2023-06-01", ...headersOf(input.target.credential) },
        body: JSON.stringify(bodyFor(input, true)),
        signal: input.signal,
      });

      await requireOk(response);

      let usage: Usage = {};
      let reason: string | null = null;
      const calls: ToolCall[] = [];
      const blocks = new Map<number, ToolCall>();

      for await (const data of sseData(requireBody(response), input.signal)) {
        let parsed: v.InferOutput<typeof StreamSchema>;

        try {
          const result = v.safeParse(StreamSchema, JSON.parse(data));

          if (!result.success) continue;

          parsed = result.output;
        } catch {
          continue;
        }

        if (parsed.type === "error") {
          throw protocolError(parsed.error?.message ?? `${label} stream returned an error`);
        }

        const startUsage = parsed.message?.usage;

        if (startUsage !== undefined && startUsage !== null) usage = mergedUsage(usage, startUsage);

        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          const call = callOf(parsed.content_block, label);

          blocks.set(parsed.index ?? 0, call);
          calls.push(call);

          yield { type: "tool_call_start", call: { id: call.id, name: call.name } };
        }

        if (parsed.type === "content_block_delta" && parsed.delta !== undefined) {
          if (parsed.delta.type === "text_delta" && parsed.delta.text) {
            yield { type: "text", text: parsed.delta.text };
          }

          if (parsed.delta.type === "input_json_delta" && parsed.delta.partial_json) {
            const call = blocks.get(parsed.index ?? 0);

            if (call === undefined)
              throw protocolError(label + " streamed arguments for a block it never opened");

            yield { type: "tool_call_delta", id: call.id, arguments: parsed.delta.partial_json };
          }
        }

        if (parsed.type === "message_delta") {
          if (parsed.delta?.stop_reason !== undefined && parsed.delta.stop_reason !== null) {
            reason = finishReason(parsed.delta.stop_reason);
          }

          if (parsed.usage !== undefined && parsed.usage !== null)
            usage = mergedUsage(usage, parsed.usage);
        }

        if (parsed.type === "message_stop") break;
      }

      yield { type: "usage", usage: usageOf(usage) };
      yield { type: "finish", reason: finishOf(reason, calls) };
    },
  };
}

function bodyFor(input: AdapterInput, stream: boolean): ChatBody {
  const conversation = conversationOf(input.request.messages);

  const system = input.request.messages
    .filter((message) => message.role === "system")
    .map((message) => textOfParts(message.content))
    .join("\n\n");

  if (conversation.length === 0) {
    throw new UpstreamError(
      "anthropic needs at least one user or assistant message",
      "invalid_request",
    );
  }

  const body: ChatBody = {
    model: input.target.upstreamModel,
    messages: conversation,
    max_tokens: input.request.maxTokens ?? 1024,
    stream,
  };

  if (system !== "") body.system = system;

  if (input.request.temperature !== undefined) body.temperature = input.request.temperature;

  if (input.request.topP !== undefined) body.top_p = input.request.topP;

  if (input.request.stop !== undefined) body.stop_sequences = [...input.request.stop];

  const toolChoice = input.request.toolChoice;

  // No pinned anthropic-version promises a "none" mode, and omitting the definitions says the same.
  if (input.request.tools.length > 0 && toolChoice?.mode !== "none")
    body.tools = input.request.tools.map(toolBodyOf);

  if (toolChoice !== null && toolChoice.mode !== "none")
    body.tool_choice = toolChoiceOf(toolChoice);

  return body;
}

function conversationOf(messages: readonly CanonicalMessage[]): MessageBody[] {
  const turns: { role: "user" | "assistant"; parts: MessagePart[] }[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    const last = turns.at(-1);

    if (last !== undefined && last.role === message.role) last.parts.push(...message.content);
    else turns.push({ role: message.role, parts: [...message.content] });
  }

  return turns.map((turn) => ({ role: turn.role, content: contentOf(turn.parts) }));
}

/** A text-only turn stays the plain string this wire received before tools existed. */
function contentOf(parts: readonly MessagePart[]): string | RequestBlock[] {
  const coalesced = coalesceText(parts, "\n\n");

  if (coalesced.every((part) => part.type === "text")) return textOfParts(coalesced);

  const blocks: RequestBlock[] = [];

  for (const part of coalesced) {
    switch (part.type) {
      case "text": {
        if (part.text !== "") blocks.push({ type: "text", text: part.text });
        break;
      }

      case "tool_call": {
        blocks.push({
          type: "tool_use",
          id: part.call.id,
          name: part.call.name,
          input: jsonObjectOf(part.call, "invalid_request"),
        });
        break;
      }

      case "tool_result": {
        const block: RequestBlock = {
          type: "tool_result",
          tool_use_id: part.result.toolCallId,
          content: part.result.content,
        };

        if (part.result.isError) block.is_error = true;

        blocks.push(block);
        break;
      }
    }
  }

  return blocks;
}

function toolBodyOf(tool: ToolDefinition): AnthropicToolBody {
  const body: AnthropicToolBody = { name: tool.name, input_schema: tool.parameters };

  if (tool.description !== null) body.description = tool.description;

  return body;
}

function toolChoiceOf(choice: Exclude<ToolChoice, { mode: "none" }>): AnthropicToolChoiceBody {
  switch (choice.mode) {
    case "auto": {
      return { type: "auto" };
    }

    case "required": {
      return { type: "any" };
    }

    case "tool": {
      return { type: "tool", name: choice.name };
    }
  }
}

function callsOf(blocks: readonly ContentBlock[], label: string): readonly ToolCall[] {
  const calls: ToolCall[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use") calls.push(callOf(block, label));
  }

  return calls;
}

/** The one place a canonical argument string is built from an object. */
function callOf(block: ContentBlock, label: string): ToolCall {
  if (block.id === undefined || block.id === null)
    throw protocolError(label + " returned a tool_use block with no id");

  if (block.name === undefined || block.name === null)
    throw protocolError(label + " returned a tool_use block with no name");

  return { id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) };
}

/** This wire counts input_tokens without its cache tiers, so both are added back for the sum. */
function usageOf(usage: Usage | null | undefined): CanonicalUsage {
  const input = usage?.input_tokens ?? null;
  const cached = usage?.cache_read_input_tokens ?? null;

  return {
    inputTokens:
      input === null ? null : input + (cached ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
    cachedInputTokens: input === null ? null : cached,
    outputTokens: usage?.output_tokens ?? null,
  };
}

/** Later stream events repeat the same counters, so a field one omits keeps its earlier value. */
function mergedUsage(current: Usage, next: Usage): Usage {
  return {
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    cache_read_input_tokens: next.cache_read_input_tokens ?? current.cache_read_input_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
  };
}

function finishReason(value: string | null): string | null {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return value;
  }
}
