import type { DuckDb } from "../duck/client";
import { SQL_NULL, sqlBool, sqlInt, sqlReal, sqlText } from "../duck/client";
import type { Exchange } from "./exchange";
import { costUsd, tokensPerSecond } from "./metrics";

export type RequestOutcome = "success" | "error" | "aborted";

export type RequestEventInput = {
  readonly userId: string;
  readonly downstreamRequestId: string;
  readonly apiKeyId: string | null;
  readonly providerId: string;
  readonly providerKind: string;
  readonly model: string;
  readonly reference: string;
  readonly projectUrl: string | null;
  readonly sessionId: string | null;
  readonly upstreamModel: string;
  readonly status: RequestOutcome;
  readonly httpStatus: number | null;
  readonly errorKind: string | null;
  readonly streamed: boolean;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ttftMs: number | null;
  readonly durationMs: number;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly startedAt: Date;
};

export function recordRequest(db: DuckDb, event: RequestEventInput): string {
  const tokensPerSecondValue = tokensPerSecond({
    outputTokens: event.outputTokens,
    ttftMs: event.ttftMs,
    durationMs: event.durationMs,
  });

  const cost = costUsd({
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    inputPricePerMtok: event.inputPricePerMtok,
    outputPricePerMtok: event.outputPricePerMtok,
  });

  const totalTokens =
    event.inputTokens === null || event.outputTokens === null
      ? null
      : event.inputTokens + event.outputTokens;

  const attemptId = crypto.randomUUID();

  db.run(
    `INSERT INTO request_events (
       id, downstream_request_id, user_id, api_key_id, provider_id, provider_kind, model, reference, project_url, session_id,
       upstream_model, status, http_status, error_kind, streamed, input_tokens, output_tokens,
       cached_input_tokens, total_tokens, cost_usd, ttft_ms, duration_ms, tokens_per_second, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::TIMESTAMP)`,
    [
      sqlText(attemptId),
      sqlText(event.downstreamRequestId),
      sqlText(event.userId),
      event.apiKeyId === null ? SQL_NULL : sqlText(event.apiKeyId),
      sqlText(event.providerId),
      sqlText(event.providerKind),
      sqlText(event.model),
      sqlText(event.reference),
      event.projectUrl === null ? SQL_NULL : sqlText(event.projectUrl),
      event.sessionId === null ? SQL_NULL : sqlText(event.sessionId),
      sqlText(event.upstreamModel),
      sqlText(event.status),
      event.httpStatus === null ? SQL_NULL : sqlInt(event.httpStatus),
      event.errorKind === null ? SQL_NULL : sqlText(event.errorKind),
      sqlBool(event.streamed),
      event.inputTokens === null ? SQL_NULL : sqlInt(event.inputTokens),
      event.outputTokens === null ? SQL_NULL : sqlInt(event.outputTokens),
      event.cachedInputTokens === null ? SQL_NULL : sqlInt(event.cachedInputTokens),
      totalTokens === null ? SQL_NULL : sqlInt(totalTokens),
      cost === null ? SQL_NULL : sqlReal(cost),
      event.ttftMs === null ? SQL_NULL : sqlInt(Math.round(event.ttftMs)),
      sqlInt(Math.round(event.durationMs)),
      tokensPerSecondValue === null ? SQL_NULL : sqlReal(tokensPerSecondValue),
      sqlText(event.startedAt.toISOString()),
    ],
  );

  return attemptId;
}

export type ExchangeInput = {
  readonly attemptId: string;
  readonly userId: string;
  readonly downstreamRequestId: string;
  readonly exchange: Exchange;
  readonly recordedAt: Date;
};

export function recordExchange(db: DuckDb, input: ExchangeInput): void {
  const exchange = input.exchange;

  db.run(
    `INSERT INTO request_exchanges (
       attempt_id, user_id, downstream_request_id, request_url, request_headers, request_body,
       response_status, response_body, truncated, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::TIMESTAMP)`,
    [
      sqlText(input.attemptId),
      sqlText(input.userId),
      sqlText(input.downstreamRequestId),
      sqlText(exchange.requestUrl),
      sqlText(exchange.requestHeaders),
      sqlText(exchange.requestBody),
      exchange.responseStatus === null ? SQL_NULL : sqlInt(exchange.responseStatus),
      exchange.responseBody === null ? SQL_NULL : sqlText(exchange.responseBody),
      sqlBool(exchange.truncated),
      sqlText(input.recordedAt.toISOString()),
    ],
  );
}
