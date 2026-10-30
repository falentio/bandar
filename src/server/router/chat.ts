import type { DuckDb } from "../duck/client";
import {
  isCoolingDown,
  recordFailure,
  recordSuccess,
  subjectFor,
  subjectKey,
  type Subject,
} from "../health";
import type { ProviderDeps } from "../providers";
import { routeAttempt, type RoutedAttempt } from "../providers/route";
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
import { openAiWire, type ChatWire } from "./wire";

export type ChatDeps = {
  readonly duck: DuckDb;
  readonly providers: ProviderDeps;
};

export type ChatInput = {
  readonly userId: string;
  readonly apiKeyId: string;
  readonly projectUrl: string | null;
  readonly sessionId: string | null;
  readonly ref: string;
  readonly request: CanonicalRequest;
  readonly stream: boolean;
  readonly signal: AbortSignal;
  readonly wire?: ChatWire;
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
  projectUrl: string | null;
  sessionId: string | null;
  startedAt: Date;
};

type Outcome = {
  status: RequestOutcome;
  httpStatus: number | null;
  errorKind: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
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
  const wire = input.wire ?? openAiWire;
  const plan = await resolvePlan(deps.providers, input.userId, input.ref);

  if (plan.attempts.length === 0) {
    return plan.tag === null
      ? wire.error(404, `model ${input.ref} is not configured`, "model_not_found")
      : wire.error(404, `tag ${plan.tag} has no enabled models`, "model_not_found");
  }

  const startedAt = new Date();
  const id = crypto.randomUUID();
  const created = Math.floor(startedAt.getTime() / 1000);
  const start = performance.now();
  const attempts = attemptPlan(deps.providers, plan, input.userId, startedAt);

  if (!input.stream) return complete(deps, input, plan, attempts, wire, id, created);

  return streamResponse(deps, { input, plan, attempts, wire, id, created, start });
}

async function complete(
  deps: ChatDeps,
  input: ChatInput,
  plan: ResolvedPlan,
  attempts: AttemptPlan,
  wire: ChatWire,
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
      const route = await routeOf(deps.providers, attempt);

      const result = await route.adapter.chat({
        target: route.target,
        request: input.request,
        signal: input.signal,
      });

      attempts.succeeded(attempt);

      const response = wire.complete({ id, created, model: plan.ref, result });

      recordSafe(deps, base, {
        status: "success",
        httpStatus: 200,
        errorKind: null,
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
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
        cachedInputTokens: null,
        outputTokens: null,
        ttftMs: null,
        durationMs: performance.now() - started,
      });

      if (aborted) {
        return wire.error(400, "request aborted", "aborted", "upstream_error");
      }

      attempts.failed(attempt, failed.kind, failed.message, new Date());

      if (!RETRYABLE.has(failed.kind)) {
        return wire.error(statusFor(failed), failed.message, failed.kind, "upstream_error");
      }

      lastFailure = failed;
    }
  }

  if (lastFailure !== null) {
    return wire.error(
      statusFor(lastFailure),
      lastFailure.message,
      lastFailure.kind,
      "upstream_error",
    );
  }

  return wire.error(502, "no upstream answered", "unavailable", "upstream_error");
}

type StreamInput = {
  readonly input: ChatInput;
  readonly plan: ResolvedPlan;
  readonly attempts: AttemptPlan;
  readonly wire: ChatWire;
  readonly id: string;
  readonly created: number;
  readonly start: number;
};

function streamResponse(deps: ChatDeps, context: StreamInput): Response {
  const { input, plan, attempts, wire } = context;
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

      const writerOf = () =>
        wire.stream({
          id: context.id,
          created: context.created,
          model: plan.ref,
          sink: { send, close },
        });

      let lastFailure: UpstreamError | null = null;

      for (const attempt of attempts.attempts) {
        if (attempts.suppressed(attempt)) continue;

        const startedAt = new Date();
        const started = performance.now();
        const base = eventBase(input, plan.ref, attempt, startedAt);
        const writer = writerOf();

        let usage: CanonicalUsage = {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
        };

        let finishReason: string | null = null;

        try {
          const route = await routeOf(deps.providers, attempt);

          for await (const event of route.adapter.stream({
            target: route.target,
            request: input.request,
            signal: abort.signal,
          })) {
            switch (event.type) {
              case "text": {
                if (event.text === "") break;

                if (ttftMs === null) ttftMs = performance.now() - context.start;

                writer.text(event.text);
                break;
              }

              case "tool_call_start": {
                if (ttftMs === null) ttftMs = performance.now() - context.start;

                writer.toolCall(event.call);
                break;
              }

              case "tool_call_delta": {
                writer.toolArguments(event.id, event.arguments);
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

          writer.finish(finishReason, usage);

          attempts.succeeded(attempt);

          recordSafe(deps, base, {
            status: "success",
            httpStatus: 200,
            errorKind: null,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
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
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            ttftMs: null,
            durationMs: performance.now() - started,
          });

          if (aborted) {
            writer.fail("request aborted", "aborted");

            return;
          }

          attempts.failed(attempt, failed.kind, failed.message, new Date());

          if (writer.started || !RETRYABLE.has(failed.kind)) {
            writer.fail(failed.message, failed.kind);

            return;
          }

          lastFailure = failed;
        }
      }

      if (lastFailure !== null) {
        writerOf().fail(lastFailure.message, lastFailure.kind);

        return;
      }

      writerOf().fail("no upstream answered", "unavailable");
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
            modelSlug: attempt.slug,
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

async function routeOf(providers: ProviderDeps, attempt: ResolvedAttempt): Promise<RoutedAttempt> {
  return routeAttempt(attempt.kind, await targetOf(providers, attempt), attempt.compat);
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
    model: attempt.slug,
    upstreamModel: attempt.upstreamModel,
    streamed: input.stream,
    inputPricePerMtok: attempt.inputPricePerMtok,
    outputPricePerMtok: attempt.outputPricePerMtok,
    reference,
    projectUrl: input.projectUrl,
    sessionId: input.sessionId,
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
    cachedInputTokens: outcome.cachedInputTokens,
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
