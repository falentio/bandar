import * as v from "valibot";

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

export const RequestEventSchema = v.object({
  id: v.string(),
  model: v.string(),
  providerKind: v.string(),
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

export type RequestEvent = v.InferOutput<typeof RequestEventSchema>;

export type RequestList = v.InferOutput<typeof RequestListSchema>;
