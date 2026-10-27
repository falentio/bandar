import type { DuckDb } from "../duck/client";
import { SQL_NULL, sqlBool, sqlInt, sqlReal, sqlText } from "../duck/client";
import { costUsd, tokensPerSecond } from "./metrics";

export type RequestOutcome = "success" | "error" | "aborted";

export type RequestEventInput = {
  readonly userId: string;
  readonly apiKeyId: string | null;
  readonly providerId: string;
  readonly providerKind: string;
  readonly model: string;
  readonly upstreamModel: string;
  readonly status: RequestOutcome;
  readonly httpStatus: number | null;
  readonly errorKind: string | null;
  readonly streamed: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ttftMs: number | null;
  readonly durationMs: number;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly startedAt: Date;
};

export function recordRequest(db: DuckDb, event: RequestEventInput): void {
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

  db.run(
    `INSERT INTO request_events (
       id, user_id, api_key_id, provider_id, provider_kind, model, upstream_model,
       status, http_status, error_kind, streamed, input_tokens, output_tokens,
       total_tokens, cost_usd, ttft_ms, duration_ms, tokens_per_second, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::TIMESTAMP)`,
    [
      sqlText(crypto.randomUUID()),
      sqlText(event.userId),
      event.apiKeyId === null ? SQL_NULL : sqlText(event.apiKeyId),
      sqlText(event.providerId),
      sqlText(event.providerKind),
      sqlText(event.model),
      sqlText(event.upstreamModel),
      sqlText(event.status),
      event.httpStatus === null ? SQL_NULL : sqlInt(event.httpStatus),
      event.errorKind === null ? SQL_NULL : sqlText(event.errorKind),
      sqlBool(event.streamed),
      event.inputTokens === null ? SQL_NULL : sqlInt(event.inputTokens),
      event.outputTokens === null ? SQL_NULL : sqlInt(event.outputTokens),
      totalTokens === null ? SQL_NULL : sqlInt(totalTokens),
      cost === null ? SQL_NULL : sqlReal(cost),
      event.ttftMs === null ? SQL_NULL : sqlInt(Math.round(event.ttftMs)),
      sqlInt(Math.round(event.durationMs)),
      tokensPerSecondValue === null ? SQL_NULL : sqlReal(tokensPerSecondValue),
      sqlText(event.startedAt.toISOString()),
    ],
  );
}
