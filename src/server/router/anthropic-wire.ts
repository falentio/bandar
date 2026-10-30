import { jsonObjectOf, type CanonicalUsage } from "../providers/types";
import type { ChatStreamInput, ChatStreamWriter, ChatWire, CompletionInput } from "./wire";

/** Characters per token for the count_tokens estimate. It is an estimate, not a tokenizer. */
export const CHARS_PER_TOKEN = 4;

export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function anthropicError(status: number, message: string, code = ""): Response {
  return Response.json(
    { type: "error", error: { type: errorTypeOf(status, code), message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export const anthropicWire: ChatWire = {
  error: anthropicError,
  complete: messageResponse,
  stream: anthropicStream,
};

type MessageUsage = { readonly input_tokens: number; readonly output_tokens: number };

type MessageBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    };

function messageResponse({ id, model, result }: CompletionInput): Response {
  const content: MessageBlock[] = [{ type: "text", text: result.text }];

  for (const call of result.toolCalls)
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: jsonObjectOf(call, "protocol"),
    });

  return Response.json(
    {
      id: messageIdOf(id),
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReasonOf(result.finishReason),
      stop_sequence: null,
      usage: usageOf(result.usage),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function anthropicStream({ id, model, sink }: ChatStreamInput): ChatStreamWriter {
  const messageId = messageIdOf(id);
  let started = false;
  let blockOpen = false;

  const start = () => {
    if (started) return;

    started = true;

    sink.send(
      frame("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  };

  const openBlock = () => {
    if (blockOpen) return;

    blockOpen = true;

    sink.send(
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
  };

  return {
    get started() {
      return started;
    },

    text(chunk) {
      start();
      openBlock();

      sink.send(
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: chunk },
        }),
      );
    },

    finish(reason, usage) {
      start();
      openBlock();

      sink.send(frame("content_block_stop", { type: "content_block_stop", index: 0 }));

      sink.send(
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReasonOf(reason), stop_sequence: null },
          usage: usageOf(usage),
        }),
      );

      sink.send(frame("message_stop", { type: "message_stop" }));
      sink.close();
    },

    fail(message, code) {
      sink.send(frame("error", { type: "error", error: { type: errorType(code), message } }));

      sink.close();
    },
  };
}

function frame(event: string, data: Payload): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Payload =
  | string
  | number
  | boolean
  | null
  | readonly Payload[]
  | { readonly [key: string]: Payload };

function messageIdOf(id: string): string {
  return `msg_${id.replaceAll("-", "")}`;
}

function usageOf(usage: CanonicalUsage): MessageUsage {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
  };
}

function stopReasonOf(reason: string | null): string {
  switch (reason) {
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_calls":
    case "tool_use":
      return "tool_use";
    case "content_filter":
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause_turn";
    default:
      return "end_turn";
  }
}

function errorTypeOf(status: number, code: string): string {
  switch (code) {
    case "auth":
    case "unauthorized":
      return "authentication_error";
    case "rate_limit":
      return "rate_limit_error";
    case "model_not_found":
    case "not_found":
      return "not_found_error";
    case "invalid_request":
    case "validation":
      return "invalid_request_error";
  }

  return errorTypeOfStatus(status);
}

function errorTypeOfStatus(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    default:
      return "api_error";
  }
}

function errorType(code: string): string {
  return errorTypeOf(0, code);
}
