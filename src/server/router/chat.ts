import type { DuckDb } from "../duck/client";
import { resolveTarget, type ProviderDeps, type ResolvedTarget } from "../providers";
import { adapterFor } from "./adapters";
import { recordRequest, type RequestEventInput, type RequestOutcome } from "./record";
import {
  UpstreamError,
  type CanonicalRequest,
  type CanonicalUsage,
  type ProviderTarget,
} from "./types";
import { completionResponse, openAiError, usageBody } from "./wire";

export type ChatDeps = {
  readonly duck: DuckDb;
  readonly providers: ProviderDeps;
};

export type ChatInput = {
  readonly userId: string;
  readonly apiKeyId: string;
  readonly alias: string;
  readonly request: CanonicalRequest;
  readonly stream: boolean;
  readonly signal: AbortSignal;
};

type EventBase = {
  userId: string;
  apiKeyId: string;
  providerId: string;
  providerKind: string;
  model: string;
  upstreamModel: string;
  streamed: boolean;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  startedAt: Date;
};

type Outcome = {
  status: RequestOutcome;
  httpStatus: number | null;
  errorKind: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ttftMs: number | null;
  durationMs: number;
};

export async function runChat(deps: ChatDeps, input: ChatInput): Promise<Response> {
  const resolved = await resolveTarget(deps.providers, input.userId, input.alias);

  if (resolved === null) {
    return openAiError(404, `model ${input.alias} is not configured`, "model_not_found");
  }

  const target: ProviderTarget = {
    providerId: resolved.providerId,
    kind: resolved.kind,
    baseUrl: resolved.baseUrl,
    credential: resolved.credential,
    upstreamModel: resolved.upstreamModel,
  };

  const startedAt = new Date();

  const base: EventBase = {
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    providerId: resolved.providerId,
    providerKind: resolved.kind,
    model: resolved.alias,
    upstreamModel: resolved.upstreamModel,
    streamed: input.stream,
    inputPricePerMtok: resolved.inputPricePerMtok,
    outputPricePerMtok: resolved.outputPricePerMtok,
    startedAt,
  };

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(startedAt.getTime() / 1000);
  const adapter = adapterFor(resolved.kind);
  const start = performance.now();

  if (!input.stream) {
    try {
      const result = await adapter.chat({ target, request: input.request, signal: input.signal });

      recordSafe(deps, base, {
        status: "success",
        httpStatus: 200,
        errorKind: null,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ttftMs: null,
        durationMs: performance.now() - start,
      });

      return completionResponse({ id, created, model: input.alias, result });
    } catch (error) {
      const failure =
        error instanceof Error
          ? failureOf(error)
          : new UpstreamError("unexpected upstream failure", "network");

      const aborted = input.signal.aborted;

      recordSafe(deps, base, {
        status: aborted ? "aborted" : "error",
        httpStatus: failure.status,
        errorKind: aborted ? "aborted" : failure.kind,
        inputTokens: null,
        outputTokens: null,
        ttftMs: null,
        durationMs: performance.now() - start,
      });

      return openAiError(
        aborted ? 400 : statusFor(failure),
        aborted ? "request aborted" : failure.message,
        aborted ? "aborted" : failure.kind,
        "upstream_error",
      );
    }
  }

  return streamResponse(deps, {
    target,
    resolved,
    base,
    request: input.request,
    signal: input.signal,
    id,
    created,
    start,
  });
}

type StreamInput = {
  target: ProviderTarget;
  resolved: ResolvedTarget;
  base: EventBase;
  request: CanonicalRequest;
  signal: AbortSignal;
  id: string;
  created: number;
  start: number;
};

function streamResponse(deps: ChatDeps, input: StreamInput): Response {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });

  let cancelled = false;
  let ttftMs: number | null = null;
  let usage: CanonicalUsage = { inputTokens: null, outputTokens: null };
  let finishReason: string | null = null;
  let status: RequestOutcome = "error";
  let errorKind: string | null = null;
  let httpStatus: number | null = null;

  const encoder = new TextEncoder();
  const adapter = adapterFor(input.target.kind);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: string) => {
        if (!cancelled) controller.enqueue(encoder.encode(payload));
      };

      const delta = (content: Record<string, string>, finish: string | null) => {
        send(
          `data: ${JSON.stringify({
            id: input.id,
            object: "chat.completion.chunk",
            created: input.created,
            model: input.base.model,
            choices: [{ index: 0, delta: content, finish_reason: finish }],
          })}\n\n`,
        );
      };

      let roleSent = false;

      try {
        for await (const event of adapter.stream({
          target: input.target,
          request: input.request,
          signal: abort.signal,
        })) {
          switch (event.type) {
            case "text": {
              if (event.text === "") break;

              if (ttftMs === null) ttftMs = performance.now() - input.start;

              if (!roleSent) {
                delta({ role: "assistant" }, null);
                roleSent = true;
              }

              delta({ content: event.text }, null);
              break;
            }

            case "usage": {
              usage = event.usage;
              break;
            }

            case "finish": {
              finishReason = event.reason;
              break;
            }

            default: {
              const _exhaustive: never = event;

              return _exhaustive;
            }
          }
        }

        if (!roleSent) delta({ role: "assistant" }, null);

        delta({}, finishReason);

        const usageChunk = usageBody(usage);

        if (usageChunk !== null) {
          send(
            `data: ${JSON.stringify({
              id: input.id,
              object: "chat.completion.chunk",
              created: input.created,
              model: input.base.model,
              choices: [],
              usage: usageChunk,
            })}\n\n`,
          );
        }

        send("data: [DONE]\n\n");
        status = "success";
      } catch (error) {
        const failure =
          error instanceof Error
            ? failureOf(error)
            : new UpstreamError("unexpected upstream failure", "network");

        const aborted = abort.signal.aborted;

        status = aborted ? "aborted" : "error";
        errorKind = aborted ? "aborted" : failure.kind;
        httpStatus = failure.status;

        send(
          `data: ${JSON.stringify({
            error: {
              message: aborted ? "request aborted" : failure.message,
              type: "upstream_error",
              code: errorKind,
            },
          })}\n\n`,
        );
        send("data: [DONE]\n\n");
      } finally {
        input.signal.removeEventListener("abort", onAbort);

        if (!cancelled) controller.close();

        recordSafe(deps, input.base, {
          status,
          httpStatus,
          errorKind,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ttftMs,
          durationMs: performance.now() - input.start,
        });
      }
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function recordSafe(deps: ChatDeps, base: EventBase, outcome: Outcome): void {
  const event: RequestEventInput = {
    ...base,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    errorKind: outcome.errorKind,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    ttftMs: outcome.ttftMs,
    durationMs: outcome.durationMs,
  };

  try {
    recordRequest(deps.duck, event);
  } catch (error) {
    console.error("gateway: could not record request", error);
  }
}

function failureOf(error: Error | UpstreamError): UpstreamError {
  if (error instanceof UpstreamError) return error;

  return new UpstreamError(error.message, "network");
}

function statusFor(error: UpstreamError): number {
  switch (error.kind) {
    case "rate_limit":
      return 429;
    case "invalid_request":
      return 400;
    case "auth":
    case "unavailable":
    case "protocol":
    case "network":
      return 502;
    default: {
      const _exhaustive: never = error.kind;

      return _exhaustive;
    }
  }
}
