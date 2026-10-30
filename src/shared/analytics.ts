import * as v from "valibot";
import { ProjectUrlSchema } from "./project";
import { SessionIdSchema } from "./session-id";
import { MAX_MODEL_REF_LENGTH, SlugSchema } from "./slugs";

export const ANALYTICS_FILTER_DIMENSIONS = [
  "providerKind",
  "providerId",
  "model",
  "tag",
  "projectUrl",
  "sessionId",
] as const;

export const MAX_ANALYTICS_FILTER_VALUES = 50;

const AnalyticsFilterValuesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_MODEL_REF_LENGTH))),
  v.maxLength(MAX_ANALYTICS_FILTER_VALUES),
);

const AnalyticsFilterTagsSchema = v.pipe(
  v.array(SlugSchema),
  v.maxLength(MAX_ANALYTICS_FILTER_VALUES),
);

const AnalyticsFilterProjectUrlsSchema = v.pipe(
  v.array(ProjectUrlSchema),
  v.maxLength(MAX_ANALYTICS_FILTER_VALUES),
);

const AnalyticsFilterSessionIdsSchema = v.pipe(
  v.array(SessionIdSchema),
  v.maxLength(MAX_ANALYTICS_FILTER_VALUES),
);

export const AnalyticsFiltersSchema = v.object({
  providerKind: AnalyticsFilterValuesSchema,
  providerId: AnalyticsFilterValuesSchema,
  model: AnalyticsFilterValuesSchema,
  tag: AnalyticsFilterTagsSchema,
  projectUrl: AnalyticsFilterProjectUrlsSchema,
  sessionId: AnalyticsFilterSessionIdsSchema,
});

export const AnalyticsSummarySchema = v.object({
  requests: v.number(),
  errors: v.number(),
  errorRate: v.number(),
  cacheHitRate: v.nullable(v.number()),
  inputTokens: v.number(),
  outputTokens: v.number(),
  totalTokens: v.number(),
  avgTokensPerDay: v.number(),
  avgTokensPerRequest: v.nullable(v.number()),
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

export const ProjectListSchema = v.object({
  projects: v.array(v.string()),
});

export const SessionListSchema = v.object({
  sessions: v.array(v.string()),
});

export const analyticsPaths = {
  analytics: "/api/analytics",
  projects: "/api/analytics/projects",
  sessions: "/api/analytics/sessions",
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

export type ProjectList = v.InferOutput<typeof ProjectListSchema>;

export type SessionList = v.InferOutput<typeof SessionListSchema>;

export const ANALYTICS_RANGES = [7, 30, 90] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_DAYS: AnalyticsRange = 30;

export const EMPTY_ANALYTICS_FILTERS: AnalyticsFilters = {
  providerKind: [],
  providerId: [],
  model: [],
  tag: [],
  projectUrl: [],
  sessionId: [],
};

export function hasAnalyticsFilters(filters: AnalyticsFilters): boolean {
  for (const dimension of ANALYTICS_FILTER_DIMENSIONS) {
    if (filters[dimension].length > 0) return true;
  }

  return false;
}
