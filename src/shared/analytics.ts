import * as v from "valibot";
import { SlugSchema } from "./slugs";

export const ANALYTICS_FILTER_DIMENSIONS = ["providerKind", "providerId", "model", "tag"] as const;

const AnalyticsFilterValuesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  v.maxLength(50),
);

const AnalyticsFilterTagsSchema = v.pipe(v.array(SlugSchema), v.maxLength(50));

export const AnalyticsFiltersSchema = v.object({
  providerKind: AnalyticsFilterValuesSchema,
  providerId: AnalyticsFilterValuesSchema,
  model: AnalyticsFilterValuesSchema,
  tag: AnalyticsFilterTagsSchema,
});

export const AnalyticsSummarySchema = v.object({
  requests: v.number(),
  errors: v.number(),
  errorRate: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  totalTokens: v.number(),
  avgTokensPerDay: v.number(),
  avgTps: v.nullable(v.number()),
  avgTtftMs: v.nullable(v.number()),
  p50DurationMs: v.nullable(v.number()),
  p95DurationMs: v.nullable(v.number()),
  costUsd: v.number(),
});

export const DailyUsageSchema = v.object({
  date: v.string(),
  requests: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  avgTps: v.nullable(v.number()),
});

export const ModelUsageSchema = v.object({
  model: v.string(),
  providerKind: v.string(),
  requests: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  avgTps: v.nullable(v.number()),
  costUsd: v.number(),
});

export const AnalyticsSchema = v.object({
  days: v.number(),
  summary: AnalyticsSummarySchema,
  daily: v.array(DailyUsageSchema),
  models: v.array(ModelUsageSchema),
});

export const ProviderUsageSchema = v.object({
  days: v.number(),
  requests: v.number(),
  errors: v.number(),
  errorRate: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  totalTokens: v.number(),
  avgTokensPerDay: v.number(),
  avgTps: v.nullable(v.number()),
  avgTtftMs: v.nullable(v.number()),
  costUsd: v.number(),
  lastRequestAt: v.nullable(v.string()),
});

export const RequestEventSchema = v.object({
  id: v.string(),
  model: v.string(),
  reference: v.nullable(v.string()),
  providerKind: v.string(),
  apiKeyId: v.nullable(v.string()),
  status: v.string(),
  inputTokens: v.nullable(v.number()),
  outputTokens: v.nullable(v.number()),
  totalTokens: v.nullable(v.number()),
  ttftMs: v.nullable(v.number()),
  durationMs: v.number(),
  tokensPerSecond: v.nullable(v.number()),
  costUsd: v.nullable(v.number()),
  errorKind: v.nullable(v.string()),
  streamed: v.boolean(),
  startedAt: v.string(),
});

export const RequestListSchema = v.object({
  requests: v.array(RequestEventSchema),
});

export const analyticsPaths = {
  analytics: "/api/analytics",
  requests: "/api/requests",
};

export type AnalyticsSummary = v.InferOutput<typeof AnalyticsSummarySchema>;

export type DailyUsage = v.InferOutput<typeof DailyUsageSchema>;

export type ModelUsage = v.InferOutput<typeof ModelUsageSchema>;

export type Analytics = v.InferOutput<typeof AnalyticsSchema>;

export type AnalyticsFilterDimension = (typeof ANALYTICS_FILTER_DIMENSIONS)[number];

export type AnalyticsFilters = Readonly<Record<AnalyticsFilterDimension, readonly string[]>>;

export type ProviderUsage = v.InferOutput<typeof ProviderUsageSchema>;

export type RequestEvent = v.InferOutput<typeof RequestEventSchema>;

export type RequestList = v.InferOutput<typeof RequestListSchema>;

export const EMPTY_ANALYTICS_FILTERS: AnalyticsFilters = {
  providerKind: [],
  providerId: [],
  model: [],
  tag: [],
};

export function hasAnalyticsFilters(filters: AnalyticsFilters): boolean {
  for (const dimension of ANALYTICS_FILTER_DIMENSIONS) {
    if (filters[dimension].length > 0) return true;
  }

  return false;
}
