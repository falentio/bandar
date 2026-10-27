import * as v from "valibot";
import {
  apiKeyHeader,
  joinUrl,
  postJson,
  protocolError,
  requireBody,
  requireOk,
  secretOf,
  sseData,
} from "../http";
import {
  UpstreamError,
  type AdapterInput,
  type CanonicalRequest,
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUsage,
  type ProviderAdapter,
} from "../../router/types";

const UsageSchema = v.object({
  input_tokens: v.optional(v.nullable(v.number())),
  output_tokens: v.optional(v.nullable(v.number())),
});

const ResponseSchema = v.object({
  content: v.array(v.object({ type: v.string(), text: v.optional(v.nullable(v.string())) })),
  stop_reason: v.optional(v.nullable(v.string())),
  usage: v.optional(v.nullable(UsageSchema)),
});

const StreamSchema = v.object({
  type: v.string(),
  message: v.optional(v.object({ usage: v.optional(v.nullable(UsageSchema)) })),
  delta: v.optional(
    v.object({
      type: v.optional(v.string()),
      text: v.optional(v.nullable(v.string())),
      stop_reason: v.optional(v.nullable(v.string())),
    }),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.object({ message: v.optional(v.string()) })),
});

type MessageBody = { role: "user" | "assistant"; content: string };

type ChatBody = {
  model: string;
  messages: MessageBody[];
  max_tokens: number;
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
};

export const anthropicAdapter: ProviderAdapter = {
  kind: "anthropic",

  async chat(input: AdapterInput): Promise<CanonicalResult> {
    const response = await postJson({
      url: joinUrl(input.target.baseUrl, "/messages"),
      headers: headersFor(secretOf(input.target.credential)),
      body: JSON.stringify(bodyFor(input, false)),
      signal: input.signal,
    });

    await requireOk(response);

    const parsed = v.safeParse(ResponseSchema, await response.json());

    if (!parsed.success) throw protocolError("anthropic returned an unexpected response shape");

    const text = parsed.output.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      text,
      finishReason: finishReason(parsed.output.stop_reason ?? null),
      usage: usageOf(parsed.output.usage),
    };
  },

  async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
    const response = await postJson({
      url: joinUrl(input.target.baseUrl, "/messages"),
      headers: headersFor(secretOf(input.target.credential)),
      body: JSON.stringify(bodyFor(input, true)),
      signal: input.signal,
    });

    await requireOk(response);

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let reason: string | null = null;

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
        throw protocolError(parsed.error?.message ?? "anthropic stream returned an error");
      }

      const startUsage = parsed.message?.usage;

      if (startUsage !== undefined && startUsage !== null) {
        inputTokens = startUsage.input_tokens ?? inputTokens;
        outputTokens = startUsage.output_tokens ?? outputTokens;
      }

      if (parsed.type === "content_block_delta" && parsed.delta !== undefined) {
        if (parsed.delta.type === "text_delta" && parsed.delta.text) {
          yield { type: "text", text: parsed.delta.text };
        }
      }

      if (parsed.type === "message_delta") {
        if (parsed.delta?.stop_reason !== undefined && parsed.delta.stop_reason !== null) {
          reason = finishReason(parsed.delta.stop_reason);
        }

        if (parsed.usage !== undefined && parsed.usage !== null) {
          inputTokens = parsed.usage.input_tokens ?? inputTokens;
          outputTokens = parsed.usage.output_tokens ?? outputTokens;
        }
      }

      if (parsed.type === "message_stop") break;
    }

    yield { type: "usage", usage: { inputTokens, outputTokens } };
    yield { type: "finish", reason };
  },
};

function bodyFor(input: AdapterInput, stream: boolean): ChatBody {
  const conversation = conversationOf(input.request.messages);

  const system = input.request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
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

  return body;
}

function conversationOf(messages: CanonicalRequest["messages"]): MessageBody[] {
  const conversation: MessageBody[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    const last = conversation.at(-1);

    if (last !== undefined && last.role === message.role) {
      last.content += `\n\n${message.content}`;
    } else {
      conversation.push({ role: message.role, content: message.content });
    }
  }

  return conversation;
}

function headersFor(apiKey: string) {
  return {
    "anthropic-version": "2023-06-01",
    ...apiKeyHeader("x-api-key", apiKey),
  };
}

function usageOf(usage: v.InferOutput<typeof UsageSchema> | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
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
