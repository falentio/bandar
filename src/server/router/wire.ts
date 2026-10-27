import type { CanonicalResult, CanonicalUsage } from "./types";

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
