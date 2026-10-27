import type { DuckDb } from "../duck/client";
import { readCredential, type ProviderDeps } from "../providers";
import { adapterFor } from "./adapters";
import { recordRequest, type RequestEventInput, type RequestOutcome } from "./record";
import { resolvePlan, type ResolvedCandidate, type ResolvedPlan } from "./resolve";
import {
  UpstreamError,
  type CanonicalRequest,
  type CanonicalUsage,
  type ProviderTarget,
  type UpstreamErrorKind,
} from "./types";
import { completionResponse, openAiError, usageBody } from "./wire";

export type ChatDeps = {
  readonly duck: DuckDb;
  readonly providers: ProviderDeps;
};

export type ChatInput = {
  readonly userId: string;
  readonly apiKeyId: string;
  readonly ref: string;
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
  reference: string;
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

const RETRYABLE: ReadonlySet<UpstreamErrorKind> = new Set([
  "auth",
  "rate_limit",
  "unavailable",
  "protocol",
  "network",
]);

export async function runChat(deps: ChatDeps, input: ChatInput): Promise<Response> {
  const plan = await resolvePlan(deps.providers, input.userId, input.ref);

  if (plan.candidates.length === 0) {
    return plan.tag === null
      ? openAiError(404, `model ${input.ref} is not configured`, "model_not_found")
      : openAiError(404, `tag ${plan.tag} has no enabled models`, "model_not_found");
  }

  const startedAt = new Date();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(startedAt.getTime() / 1000);
  const start = performance.now();

  if (!input.stream) return complete(deps, input, plan, id, created);

  return streamResponse(deps, { input, plan, id, created, start });
}

async function complete(
  deps: ChatDeps,
  input: ChatInput,
  plan: ResolvedPlan,
  id: string,
  created: number,
): Promise<Response> {
  let failure: UpstreamError | null = null;

  for (const [index, candidate] of plan.candidates.entries()) {
    const startedAt = new Date();
    const started = performance.now();
    const base = eventBase(input, plan.ref, candidate, startedAt);
    const last = index === plan.candidates.length - 1;

    try {
      const target = await targetOf(deps.providers, candidate);

      const result = await adapterFor(candidate.kind).chat({
        target,
        request: input.request,
        signal: input.signal,
      });

      recordSafe(deps, base, {
        status: "success",
        httpStatus: 200,
        errorKind: null,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ttftMs: null,
        durationMs: performance.now() - started,
      });

      return completionResponse({ id, created, model: plan.ref, result });
    } catch (error) {
      const failed =
        error instanceof Error
          ? failureOf(error)
          : new UpstreamError("unexpected upstream failure", "network");

      const aborted = input.signal.aborted;

      failure = failed;

      recordSafe(deps, base, {
        status: aborted ? "aborted" : "error",
        httpStatus: failed.status,
        errorKind: aborted ? "aborted" : failed.kind,
        inputTokens: null,
        outputTokens: null,
        ttftMs: null,
        durationMs: performance.now() - started,
      });

      if (aborted || last || !RETRYABLE.has(failed.kind)) {
        return openAiError(
          aborted ? 400 : statusFor(failed),
          aborted ? "request aborted" : failed.message,
          aborted ? "aborted" : failed.kind,
          "upstream_error",
        );
      }
    }
  }

  const failed = failure ?? new UpstreamError("no upstream answered", "unavailable");

  return openAiError(statusFor(failed), failed.message, failed.kind, "upstream_error");
}

type StreamInput = {
  readonly input: ChatInput;
  readonly plan: ResolvedPlan;
  readonly id: string;
  readonly created: number;
  readonly start: number;
};

function streamResponse(deps: ChatDeps, context: StreamInput): Response {
  const { input, plan } = context;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });

  let cancelled = false;
  let ttftMs: number | null = null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: string) => {
        if (!cancelled) controller.enqueue(encoder.encode(payload));
      };

      const close = () => {
        if (!cancelled) controller.close();
      };

      const fail = (message: string, code: string) => {
        send(`data: ${JSON.stringify({ error: { message, type: "upstream_error", code } })}\n\n`);
        send("data: [DONE]\n\n");
        close();
      };

      for (const [index, candidate] of plan.candidates.entries()) {
        const startedAt = new Date();
        const started = performance.now();
        const base = eventBase(input, plan.ref, candidate, startedAt);
        const last = index === plan.candidates.length - 1;

        let chunksSent = 0;
        let roleSent = false;
        let usage: CanonicalUsage = { inputTokens: null, outputTokens: null };
        let finishReason: string | null = null;

        const enqueue = (payload: string) => {
          if (cancelled) return;

          controller.enqueue(encoder.encode(payload));
          chunksSent += 1;
        };

        const delta = (content: Record<string, string>, finish: string | null) => {
          enqueue(
            `data: ${JSON.stringify({
              id: context.id,
              object: "chat.completion.chunk",
              created: context.created,
              model: plan.ref,
              choices: [{ index: 0, delta: content, finish_reason: finish }],
            })}\n\n`,
          );
        };

        try {
          const target = await targetOf(deps.providers, candidate);

          for await (const event of adapterFor(candidate.kind).stream({
            target,
            request: input.request,
            signal: abort.signal,
          })) {
            switch (event.type) {
              case "text": {
                if (event.text === "") break;

                if (ttftMs === null) ttftMs = performance.now() - context.start;

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
            enqueue(
              `data: ${JSON.stringify({
                id: context.id,
                object: "chat.completion.chunk",
                created: context.created,
                model: plan.ref,
                choices: [],
                usage: usageChunk,
              })}\n\n`,
            );
          }

          recordSafe(deps, base, {
            status: "success",
            httpStatus: 200,
            errorKind: null,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ttftMs,
            durationMs: performance.now() - started,
          });

          send("data: [DONE]\n\n");
          close();

          return;
        } catch (error) {
          const failed =
            error instanceof Error
              ? failureOf(error)
              : new UpstreamError("unexpected upstream failure", "network");

          const aborted = abort.signal.aborted;

          recordSafe(deps, base, {
            status: aborted ? "aborted" : "error",
            httpStatus: failed.status,
            errorKind: aborted ? "aborted" : failed.kind,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ttftMs: null,
            durationMs: performance.now() - started,
          });

          if (aborted) {
            fail("request aborted", "aborted");

            return;
          }

          if (chunksSent > 0 || last || !RETRYABLE.has(failed.kind)) {
            fail(failed.message, failed.kind);

            return;
          }
        }
      }

      fail("no upstream answered", "unavailable");
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

async function targetOf(
  providers: ProviderDeps,
  candidate: ResolvedCandidate,
): Promise<ProviderTarget> {
  return {
    providerId: candidate.providerId,
    kind: candidate.kind,
    baseUrl: candidate.baseUrl,
    credential: await readCredential(providers, candidate.sealedKey),
    upstreamModel: candidate.upstreamModel,
  };
}

function eventBase(
  input: ChatInput,
  reference: string,
  candidate: ResolvedCandidate,
  startedAt: Date,
): EventBase {
  return {
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    providerId: candidate.providerId,
    providerKind: candidate.kind,
    model: candidate.alias,
    upstreamModel: candidate.upstreamModel,
    streamed: input.stream,
    inputPricePerMtok: candidate.inputPricePerMtok,
    outputPricePerMtok: candidate.outputPricePerMtok,
    reference,
    startedAt,
  };
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
