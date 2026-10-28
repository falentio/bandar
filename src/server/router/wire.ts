import type { CanonicalResult, CanonicalUsage } from "../providers/types";

export function openAiError(
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error",
): Response {
  return Response.json(
    { error: { message, type, param: null, code } },
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
  const body: CompletionBody = {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.result.text },
        finish_reason: input.result.finishReason ?? "stop",
      },
    ],
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

type CompletionBody = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }[];
  usage?: UsageBody;
};

/** The response frames one ingress dialect writes into a streamed chat. */
export type ChatStreamWriter = {
  /** True once a frame reached the client, which ends the retry window for this attempt. */
  readonly started: boolean;
  text(text: string): void;
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
  const completionId = `chatcmpl-${id}`;
  let started = false;
  let roleSent = false;

  const delta = (content: Record<string, string>, finish: string | null) => {
    sink.send(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: content, finish_reason: finish }],
      })}\n\n`,
    );
    started = true;
  };

  return {
    get started() {
      return started;
    },

    text(chunk) {
      if (!roleSent) {
        delta({ role: "assistant" }, null);
        roleSent = true;
      }

      delta({ content: chunk }, null);
    },

    finish(reason, usage) {
      if (!roleSent) delta({ role: "assistant" }, null);

      delta({}, reason);

      const usageChunk = usageBody(usage);

      if (usageChunk !== null) {
        sink.send(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: usageChunk,
          })}\n\n`,
        );
      }

      sink.send("data: [DONE]\n\n");
      sink.close();
    },

    fail(message, code) {
      sink.send(
        `data: ${JSON.stringify({ error: { message, type: "upstream_error", code } })}\n\n`,
      );
      sink.send("data: [DONE]\n\n");
      sink.close();
    },
  };
}
