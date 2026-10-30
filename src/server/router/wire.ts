import type { ToolCall, ToolCallDraft } from "../../shared/conversation";
import type { CanonicalResult, CanonicalUsage } from "../providers/types";

export function openAiError(
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error",
  param: string | null = null,
): Response {
  return Response.json(
    { error: { message, type, param, code } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export type CompletionInput = {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly result: CanonicalResult;
};

export function completionResponse(input: CompletionInput): Response {
  const message: CompletionMessage = { role: "assistant", content: input.result.text };

  if (input.result.toolCalls.length > 0)
    message.tool_calls = input.result.toolCalls.map(toolCallBody);

  const body: CompletionBody = {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [{ index: 0, message, finish_reason: input.result.finishReason ?? "stop" }],
  };

  const usage = usageBody(input.result.usage);

  if (usage !== null) body.usage = usage;

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

export function usageBody(usage: CanonicalUsage): UsageBody | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;

  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

export type UsageBody = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** One assistant tool call as this dialect spells it on the completed message. */
export type ToolCallBody = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CompletionMessage = {
  role: "assistant";
  content: string;
  tool_calls?: ToolCallBody[];
};

type CompletionBody = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: CompletionMessage;
    finish_reason: string;
  }[];
  usage?: UsageBody;
};

function toolCallBody(call: ToolCall): ToolCallBody {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

/** The response frames one ingress dialect writes into a streamed chat. */
export type ChatStreamWriter = {
  /** True once a frame reached the client, which ends the retry window for this attempt. */
  readonly started: boolean;
  text(text: string): void;
  /** Opens a call and names it, so the client can show it before its arguments arrive. */
  toolCall(call: ToolCallDraft): void;
  /** Appends raw JSON text to a call already opened by toolCall. */
  toolArguments(id: string, delta: string): void;
  finish(reason: string | null, usage: CanonicalUsage): void;
  fail(message: string, code: string): void;
};

export type ChatStreamSink = {
  readonly send: (payload: string) => void;
  readonly close: () => void;
};

export type ChatStreamInput = {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly sink: ChatStreamSink;
};

/** One ingress wire: its error envelope, its completed response, and its stream frames. */
export type ChatWire = {
  readonly error: (status: number, message: string, code: string, type?: string) => Response;
  readonly complete: (input: CompletionInput) => Response;
  readonly stream: (input: ChatStreamInput) => ChatStreamWriter;
};

export const openAiWire: ChatWire = {
  error: openAiError,
  complete: (input) => completionResponse({ ...input, id: `chatcmpl-${input.id}` }),
  stream: openAiStream,
};

function openAiStream({ id, created, model, sink }: ChatStreamInput): ChatStreamWriter {
  const completionId = "chatcmpl-" + id;
  const indexes = new Map<string, number>();
  let started = false;
  let roleSent = false;

  const delta = (content: Payload, finish: string | null) => {
    sink.send(
      "data: " +
        JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: content, finish_reason: finish }],
        }) +
        "\n\n",
    );
    started = true;
  };

  const sendRole = () => {
    if (roleSent) return;

    delta({ role: "assistant" }, null);
    roleSent = true;
  };

  return {
    get started() {
      return started;
    },

    text(chunk) {
      sendRole();
      delta({ content: chunk }, null);
    },

    toolCall(call) {
      if (indexes.has(call.id)) return;

      const index = indexes.size;

      indexes.set(call.id, index);
      sendRole();
      delta(
        {
          tool_calls: [
            { index, id: call.id, type: "function", function: { name: call.name, arguments: "" } },
          ],
        },
        null,
      );
    },

    toolArguments(id, fragment) {
      const index = indexes.get(id);

      if (index === undefined) throw new Error("no tool call " + id + " was announced");

      delta({ tool_calls: [{ index, function: { arguments: fragment } }] }, null);
    },

    finish(reason, usage) {
      sendRole();

      delta({}, reason);

      const usageChunk = usageBody(usage);

      if (usageChunk !== null) {
        sink.send(
          "data: " +
            JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              usage: usageChunk,
            }) +
            "\n\n",
        );
      }

      sink.send("data: [DONE]\n\n");
      sink.close();
    },

    fail(message, code) {
      sink.send(
        "data: " + JSON.stringify({ error: { message, type: "upstream_error", code } }) + "\n\n",
      );
      sink.send("data: [DONE]\n\n");
      sink.close();
    },
  };
}

type Payload =
  | string
  | number
  | boolean
  | null
  | readonly Payload[]
  | { readonly [key: string]: Payload };
