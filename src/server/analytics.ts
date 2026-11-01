import {
  ANALYTICS_FILTER_DIMENSIONS,
  MAX_ANALYTICS_FILTER_VALUES,
  analyticsWindow,
  type Analytics,
  type AnalyticsFilterDimension,
  type AnalyticsFilters,
  type AnalyticsGranularity,
} from "../shared/analytics";
import { projectUrlOf } from "../shared/project";
import { sessionIdOf } from "../shared/session-id";
import { tagRefOf } from "../shared/slugs";
import type { DuckDb, QueryRow } from "./duck/client";
import { SQL_NULL, sqlInt, sqlText, type SqlValue } from "./duck/client";
import { errorRate, round } from "./router/metrics";

export type AnalyticsQuery = {
  readonly userId: string;
  readonly days: number;
  readonly filters: AnalyticsFilters;
  readonly now?: Date;
};

export type RequestsQuery = {
  readonly userId: string;
  readonly limit: number;
  readonly providerId?: string;
};

export type RequestEvent = {
  readonly id: string;
  readonly model: string;
  readonly reference: string | null;
  readonly providerKind: string;
  readonly apiKeyId: string | null;
  readonly status: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly ttftMs: number | null;
  readonly durationMs: number;
  readonly tokensPerSecond: number | null;
  readonly costUsd: number | null;
  readonly errorKind: string | null;
  readonly streamed: boolean;
  readonly startedAt: string;
};

export type RequestList = { readonly requests: readonly RequestEvent[] };

type FilterClause = {
  readonly clauses: readonly string[];
  readonly params: readonly SqlValue[];
};

type FilterSpec = {
  readonly column: string;
  readonly value: (raw: string) => string | null;
};

const identity = (raw: string): string => raw;

type BucketSpec = {
  readonly interval: string;
  readonly trunc: string;
  readonly stepMs: number;
};

// The two bucket sizes differ only in these fragments, so one query serves both.
const BUCKET_SPECS: Record<AnalyticsGranularity, BucketSpec> = {
  hour: {
    interval: "1 HOUR",
    trunc: "date_trunc('hour', events.started_at)",
    stepMs: 3_600_000,
  },
  day: {
    interval: "1 DAY",
    trunc: "CAST(CAST(events.started_at AS DATE) AS TIMESTAMP)",
    stepMs: 86_400_000,
  },
};

const FILTER_SPECS: Record<AnalyticsFilterDimension, FilterSpec> = {
  providerKind: { column: "provider_kind", value: identity },
  providerId: { column: "provider_id", value: identity },
  model: { column: "model", value: identity },
  tag: { column: "reference", value: tagRefOf },
  projectUrl: { column: "project_url", value: projectUrlOf },
  sessionId: { column: "session_id", value: sessionIdOf },
};

export function readAnalytics(db: DuckDb, query: AnalyticsQuery): Analytics {
  const end = startOfUtcDay(query.now ?? new Date());
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (query.days - 1));

  const filter = filterClause(query.filters);
  const filterSql = filter.clauses.length === 0 ? "" : ` AND ${filter.clauses.join(" AND ")}`;

  const summary = db.query(
    `SELECT
       count(*) AS requests,
       count(*) FILTER (WHERE status <> 'success') AS errors,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens,
       coalesce(sum(cost_usd), 0) AS cost_usd,
       avg(ttft_ms) AS avg_ttft_ms,
       approx_quantile(duration_ms, 0.5) AS p50_duration_ms,
       approx_quantile(duration_ms, 0.95) AS p95_duration_ms,
       avg(tokens_per_second) AS avg_tps,
       coalesce(sum(cached_input_tokens) FILTER (WHERE cached_input_tokens IS NOT NULL), 0)
         / nullif(sum(input_tokens) FILTER (WHERE cached_input_tokens IS NOT NULL), 0)
         AS cache_hit_rate
     FROM request_events
     WHERE user_id = ? AND started_at >= ?::TIMESTAMP${filterSql}`,
    [sqlText(query.userId), sqlText(start.toISOString()), ...filter.params],
  )[0];

  if (summary === undefined) throw new Error("analytics summary returned no row");

  const requests = number(summary, "requests");
  const cacheHitRate = nullableNumber(summary, "cache_hit_rate");
  const inputTokens = number(summary, "input_tokens");
  const outputTokens = number(summary, "output_tokens");
  const totalTokens = inputTokens + outputTokens;

  const { granularity, bucketCount } = analyticsWindow(query.days);
  const bucketSpec = BUCKET_SPECS[granularity];
  const seriesEnd = new Date(start.getTime() + (bucketCount - 1) * bucketSpec.stepMs);

  // The clauses belong in the join condition: in WHERE they would drop the empty buckets.
  const buckets = db.query(
    `WITH buckets AS (
       SELECT CAST(bucket AS TIMESTAMP) AS bucket
       FROM generate_series(?::TIMESTAMP, ?::TIMESTAMP, INTERVAL ${bucketSpec.interval}) AS series(bucket)
     )
     SELECT
       epoch_ms(buckets.bucket) AS bucket_ms,
       count(events.id) AS requests,
       coalesce(sum(events.input_tokens), 0) AS input_tokens,
       coalesce(sum(events.output_tokens), 0) AS output_tokens,
       avg(events.tokens_per_second) AS avg_tps
     FROM buckets
     LEFT JOIN request_events events
       ON events.user_id = ? AND ${bucketSpec.trunc} = buckets.bucket${filterSql}
     GROUP BY buckets.bucket
     ORDER BY buckets.bucket`,
    [
      sqlText(start.toISOString()),
      sqlText(seriesEnd.toISOString()),
      sqlText(query.userId),
      ...filter.params,
    ],
  );

  const models = db.query(
    `SELECT
       model,
       provider_kind,
       count(*) AS requests,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens,
       coalesce(sum(cost_usd), 0) AS cost_usd,
       avg(tokens_per_second) AS avg_tps
     FROM request_events
     WHERE user_id = ? AND started_at >= ?::TIMESTAMP${filterSql}
     GROUP BY model, provider_kind
     ORDER BY sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) DESC, model ASC
     LIMIT 20`,
    [sqlText(query.userId), sqlText(start.toISOString()), ...filter.params],
  );

  return {
    days: query.days,
    granularity,
    summary: {
      requests,
      errors: number(summary, "errors"),
      errorRate: errorRate(number(summary, "errors"), requests),
      cacheHitRate: cacheHitRate === null ? null : round(cacheHitRate, 4),
      inputTokens,
      outputTokens,
      totalTokens,
      avgTokensPerDay: round(totalTokens / query.days, 2),
      avgTokensPerRequest: requests === 0 ? null : round(totalTokens / requests, 1),
      avgTps: nullableNumber(summary, "avg_tps"),
      avgTtftMs: nullableNumber(summary, "avg_ttft_ms"),
      p50DurationMs: nullableNumber(summary, "p50_duration_ms"),
      p95DurationMs: nullableNumber(summary, "p95_duration_ms"),
      costUsd: round(number(summary, "cost_usd"), 6),
    },
    buckets: buckets.map((row) => ({
      start: new Date(number(row, "bucket_ms")).toISOString(),
      requests: number(row, "requests"),
      inputTokens: number(row, "input_tokens"),
      outputTokens: number(row, "output_tokens"),
      avgTps: nullableNumber(row, "avg_tps"),
    })),
    models: models.map((row) => ({
      model: string(row, "model"),
      providerKind: string(row, "provider_kind"),
      requests: number(row, "requests"),
      inputTokens: number(row, "input_tokens"),
      outputTokens: number(row, "output_tokens"),
      avgTps: nullableNumber(row, "avg_tps"),
      costUsd: round(number(row, "cost_usd"), 6),
    })),
  };
}

export function readRequests(db: DuckDb, query: RequestsQuery): RequestList {
  const providerId = query.providerId ?? null;

  const rows = db.query(
    `SELECT
       id, model, reference, provider_kind, api_key_id, status, input_tokens, output_tokens,
       total_tokens, ttft_ms, duration_ms, tokens_per_second, cost_usd, error_kind, streamed,
       epoch_ms(started_at) AS started_at_ms
     FROM request_events
     WHERE user_id = ? AND (? IS NULL OR provider_id = ?)
     ORDER BY started_at DESC
     LIMIT ?`,
    [
      sqlText(query.userId),
      providerParam(providerId),
      providerParam(providerId),
      sqlInt(query.limit),
    ],
  );

  return {
    requests: rows.map((row) => ({
      id: string(row, "id"),
      model: string(row, "model"),
      reference: stringOrNull(row, "reference"),
      providerKind: string(row, "provider_kind"),
      apiKeyId: stringOrNull(row, "api_key_id"),
      status: string(row, "status"),
      inputTokens: nullableNumber(row, "input_tokens"),
      outputTokens: nullableNumber(row, "output_tokens"),
      totalTokens: nullableNumber(row, "total_tokens"),
      ttftMs: nullableNumber(row, "ttft_ms"),
      durationMs: number(row, "duration_ms"),
      tokensPerSecond: nullableNumber(row, "tokens_per_second"),
      costUsd: nullableNumber(row, "cost_usd"),
      errorKind: stringOrNull(row, "error_kind"),
      streamed: row.streamed === "true",
      startedAt: new Date(number(row, "started_at_ms")).toISOString(),
    })),
  };
}

export type FilterValuesQuery = {
  readonly userId: string;
};

export function readProjectUrls(db: DuckDb, query: FilterValuesQuery): readonly string[] {
  const rows = db.query(
    `SELECT project_url
     FROM request_events
     WHERE user_id = ? AND project_url IS NOT NULL
     GROUP BY project_url
     ORDER BY max(started_at) DESC, project_url ASC
     LIMIT ?`,
    [sqlText(query.userId), sqlInt(MAX_ANALYTICS_FILTER_VALUES)],
  );

  return rows.map((row) => string(row, "project_url"));
}

export function readSessionIds(db: DuckDb, query: FilterValuesQuery): readonly string[] {
  const rows = db.query(
    `SELECT session_id
     FROM request_events
     WHERE user_id = ? AND session_id IS NOT NULL
     GROUP BY session_id
     ORDER BY max(started_at) DESC, session_id ASC
     LIMIT ?`,
    [sqlText(query.userId), sqlInt(MAX_ANALYTICS_FILTER_VALUES)],
  );

  return rows.map((row) => string(row, "session_id"));
}

function filterClause(filters: AnalyticsFilters): FilterClause {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  for (const dimension of ANALYTICS_FILTER_DIMENSIONS) {
    const requested = filters[dimension];

    if (requested.length === 0) continue;

    const spec = FILTER_SPECS[dimension];
    const placeholders: string[] = [];

    for (const raw of requested) {
      const value = spec.value(raw);

      if (value === null) continue;

      placeholders.push("?");
      params.push(sqlText(value));
    }

    clauses.push(
      placeholders.length === 0 ? "FALSE" : `${spec.column} IN (${placeholders.join(", ")})`,
    );
  }

  return { clauses, params };
}

function providerParam(value: string | null): SqlValue {
  return value === null ? SQL_NULL : sqlText(value);
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function number(row: QueryRow, key: string): number {
  const value = row[key];

  if (value === null || value === undefined) throw new Error(`missing column ${key}`);

  return Number(value);
}

function nullableNumber(row: QueryRow, key: string): number | null {
  const value = row[key];

  return value === null || value === undefined ? null : Number(value);
}

function string(row: QueryRow, key: string): string {
  const value = row[key];

  if (value === null || value === undefined) throw new Error(`missing column ${key}`);

  return value;
}

function stringOrNull(row: QueryRow, key: string): string | null {
  return row[key] ?? null;
}
