import type { DuckDb } from "../duck/client";
import {
  isCoolingDown,
  recordFailure,
  recordSuccess,
  subjectFor,
  subjectKey,
  type Subject,
} from "../health";
import { definitionFor, type ProviderDeps } from "../providers";
import { freshCredential } from "../providers/refresh";
import { recordRequest, type RequestEventInput, type RequestOutcome } from "./record";
import { resolvePlan, type ResolvedAttempt, type ResolvedPlan } from "./resolve";
import {
  UpstreamError,
  type CanonicalRequest,
  type CanonicalUsage,
  type ProviderTarget,
  type UpstreamErrorKind,
} from "../providers/types";
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

type AttemptPlan = {
  readonly attempts: readonly ResolvedAttempt[];
  suppressed(attempt: ResolvedAttempt): boolean;
  failed(attempt: ResolvedAttempt, kind: UpstreamErrorKind, message: string, now: Date): void;
  succeeded(attempt: ResolvedAttempt): void;
};

const RETRYABLE: ReadonlySet<UpstreamErrorKind> = new Set([
  "auth",
  "rate_limit",
  "not_found",
  "unavailable",
  "protocol",
  "network",
  "unknown",
]);

export async function runChat(deps: ChatDeps, input: ChatInput): Promise<Response> {
  const plan = await resolvePlan(deps.providers, input.userId, input.ref);

  if (plan.attempts.length === 0) {
    return plan.tag === null
      ? openAiError(404, `model ${input.ref} is not configured`, "model_not_found")
      : openAiError(404, `tag ${plan.tag} has no enabled models`, "model_not_found");
  }

  const startedAt = new Date();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(startedAt.getTime() / 1000);
  const start = performance.now();
  const attempts = attemptPlan(deps.providers, plan, input.userId, startedAt);

  if (!input.stream) return complete(deps, input, plan, attempts, id, created);

  return streamResponse(deps, { input, plan, attempts, id, created, start });
}

async function complete(
  deps: ChatDeps,
  input: ChatInput,
  plan: ResolvedPlan,
  attempts: AttemptPlan,
  id: string,
  created: number,
): Promise<Response> {
  let lastFailure: UpstreamError | null = null;

  for (const attempt of attempts.attempts) {
    if (attempts.suppressed(attempt)) continue;

    const startedAt = new Date();
    const started = performance.now();
    const base = eventBase(input, plan.ref, attempt, startedAt);

    try {
      const target = await targetOf(deps.providers, attempt);

      const result = await definitionFor(attempt.kind).adapter.chat({
        target,
        request: input.request,
        signal: input.signal,
      });

      attempts.succeeded(attempt);

      const response = completionResponse({ id, created, model: plan.ref, result });

      recordSafe(deps, base, {
        status: "success",
        httpStatus: 200,
        errorKind: null,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ttftMs: null,
        durationMs: performance.now() - started,
      });

      return response;
    } catch (error) {
      const failed =
        error instanceof Error
          ? failureOf(error)
          : new UpstreamError("unexpected upstream failure", "unknown");

      const aborted = input.signal.aborted;

      recordSafe(deps, base, {
        status: aborted ? "aborted" : "error",
        httpStatus: failed.status,
        errorKind: aborted ? "aborted" : failed.kind,
        inputTokens: null,
        outputTokens: null,
        ttftMs: null,
        durationMs: performance.now() - started,
      });

      if (aborted) {
        return openAiError(400, "request aborted", "aborted", "upstream_error");
      }

      attempts.failed(attempt, failed.kind, failed.message, new Date());

      if (!RETRYABLE.has(failed.kind)) {
        return openAiError(statusFor(failed), failed.message, failed.kind, "upstream_error");
      }

      lastFailure = failed;
    }
  }

  if (lastFailure !== null) {
    return openAiError(
      statusFor(lastFailure),
      lastFailure.message,
      lastFailure.kind,
      "upstream_error",
    );
  }

  return openAiError(502, "no upstream answered", "unavailable", "upstream_error");
}

type StreamInput = {
  readonly input: ChatInput;
  readonly plan: ResolvedPlan;
  readonly attempts: AttemptPlan;
  readonly id: string;
  readonly created: number;
  readonly start: number;
};

function streamResponse(deps: ChatDeps, context: StreamInput): Response {
  const { input, plan, attempts } = context;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  const detach = () => input.signal.removeEventListener("abort", onAbort);
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
        detach();

        if (!cancelled) controller.close();
      };

      const fail = (message: string, code: string) => {
        detach();
        send(`data: ${JSON.stringify({ error: { message, type: "upstream_error", code } })}\n\n`);
        send("data: [DONE]\n\n");
        close();
      };

      let lastFailure: UpstreamError | null = null;

      for (const attempt of attempts.attempts) {
        if (attempts.suppressed(attempt)) continue;

        const startedAt = new Date();
        const started = performance.now();
        const base = eventBase(input, plan.ref, attempt, startedAt);

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
          const target = await targetOf(deps.providers, attempt);

          for await (const event of definitionFor(attempt.kind).adapter.stream({
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

          send("data: [DONE]\n\n");
          close();

          attempts.succeeded(attempt);

          recordSafe(deps, base, {
            status: "success",
            httpStatus: 200,
            errorKind: null,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ttftMs,
            durationMs: performance.now() - started,
          });

          return;
        } catch (error) {
          const failed =
            error instanceof Error
              ? failureOf(error)
              : new UpstreamError("unexpected upstream failure", "unknown");

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

          attempts.failed(attempt, failed.kind, failed.message, new Date());

          if (chunksSent > 0 || !RETRYABLE.has(failed.kind)) {
            fail(failed.message, failed.kind);

            return;
          }

          lastFailure = failed;
        }
      }

      if (lastFailure !== null) {
        fail(lastFailure.message, lastFailure.kind);

        return;
      }

      fail("no upstream answered", "unavailable");
    },
    cancel() {
      cancelled = true;
      abort.abort();
      detach();
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

function attemptPlan(
  providers: ProviderDeps,
  plan: ResolvedPlan,
  userId: string,
  startedAt: Date,
): AttemptPlan {
  const attempts = plan.attempts;
  const now = startedAt.getTime();
  const cooling = new Set<string>();
  let probe = true;

  for (const attempt of attempts) {
    let skippable = false;

    for (const subject of subjectsOf(attempt)) {
      if (isCoolingDown(flaggedUntilOf(attempt, subject), now)) {
        cooling.add(subjectKey(subject));
        skippable = true;
      }
    }

    if (!skippable) probe = false;
  }

  return {
    attempts,
    suppressed: (attempt) =>
      !probe && subjectsOf(attempt).some((subject) => cooling.has(subjectKey(subject))),
    failed: (attempt, kind, message, at) => {
      const subject = subjectFor(kind, {
        providerId: attempt.providerId,
        modelId: attempt.modelId,
        credentialId: attempt.credentialId,
      });

      if (subject === null) return;

      try {
        recordFailure(providers.db, {
          subject,
          context: {
            userId,
            reference: plan.ref,
            errorKind: kind,
            message,
            providerId: attempt.providerId,
            providerName: attempt.providerName,
            modelId: attempt.modelId,
            modelAlias: attempt.alias,
            credentialId: attempt.credentialId,
            credentialName: attempt.credentialId === null ? null : attempt.credentialLabel,
          },
          now: at,
        });
      } catch (error) {
        console.error("gateway: could not record upstream failure", error);
      }

      cooling.add(subjectKey(subject));
    },
    succeeded: (attempt) => {
      try {
        recordSuccess(providers.db, subjectsOf(attempt));
      } catch (error) {
        console.error("gateway: could not clear upstream health", error);
      }
    },
  };
}

function subjectsOf(attempt: ResolvedAttempt): readonly Subject[] {
  const subjects: Subject[] = [
    { kind: "provider", id: attempt.providerId },
    { kind: "model", id: attempt.modelId },
  ];

  if (attempt.credentialId !== null)
    subjects.push({ kind: "credential", id: attempt.credentialId });

  return subjects;
}

function flaggedUntilOf(attempt: ResolvedAttempt, subject: Subject): Date | null {
  switch (subject.kind) {
    case "provider": {
      return attempt.providerFlaggedUntil;
    }

    case "model": {
      return attempt.modelFlaggedUntil;
    }

    case "credential": {
      return attempt.credentialFlaggedUntil;
    }

    default: {
      const _exhaustive: never = subject;

      return _exhaustive;
    }
  }
}

async function targetOf(
  providers: ProviderDeps,
  attempt: ResolvedAttempt,
): Promise<ProviderTarget> {
  return {
    providerId: attempt.providerId,
    kind: attempt.kind,
    baseUrl: attempt.baseUrl,
    credential: await freshCredential(providers, attempt),
    upstreamModel: attempt.upstreamModel,
  };
}

function eventBase(
  input: ChatInput,
  reference: string,
  attempt: ResolvedAttempt,
  startedAt: Date,
): EventBase {
  return {
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    providerId: attempt.providerId,
    providerKind: attempt.kind,
    model: attempt.alias,
    upstreamModel: attempt.upstreamModel,
    streamed: input.stream,
    inputPricePerMtok: attempt.inputPricePerMtok,
    outputPricePerMtok: attempt.outputPricePerMtok,
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

  return new UpstreamError(error.message, "unknown");
}

function statusFor(error: UpstreamError): number {
  switch (error.kind) {
    case "rate_limit":
      return 429;
    case "invalid_request":
      return 400;
    case "not_found":
      return 404;
    case "auth":
    case "unavailable":
    case "protocol":
    case "network":
    case "unknown":
      return 502;
    default: {
      const _exhaustive: never = error.kind;

      return _exhaustive;
    }
  }
}
