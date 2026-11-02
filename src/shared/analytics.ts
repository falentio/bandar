import * as v from "valibot";
import { ProjectUrlSchema } from "./project";
import { SessionIdSchema } from "./session-id";
import { MAX_MODEL_REF_LENGTH, SlugSchema } from "./slugs";

export const ANALYTICS_GRANULARITIES = ["hour", "day"] as const;

export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

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

export const UsageBucketSchema = v.object({
  start: v.string(),
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
  granularity: v.picklist(ANALYTICS_GRANULARITIES),
  summary: AnalyticsSummarySchema,
  buckets: v.array(UsageBucketSchema),
  models: v.array(ModelUsageSchema),
});

export const RequestEventSchema = v.object({
  id: v.string(),
  model: v.string(),
  reference: v.nullable(v.string()),
  providerKind: v.string(),
  providerId: v.string(),
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

export const DownstreamRequestSchema = v.object({
  id: v.string(),
  startedAt: v.string(),
  status: v.string(),
  reference: v.nullable(v.string()),
  apiKeyId: v.nullable(v.string()),
  projectUrl: v.nullable(v.string()),
  sessionId: v.nullable(v.string()),
  streamed: v.boolean(),
  attempts: v.array(RequestEventSchema),
});

export const RequestListSchema = v.object({
  requests: v.array(DownstreamRequestSchema),
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

export type UsageBucket = v.InferOutput<typeof UsageBucketSchema>;

export type ModelUsage = v.InferOutput<typeof ModelUsageSchema>;

export type Analytics = v.InferOutput<typeof AnalyticsSchema>;

export type AnalyticsFilterDimension = (typeof ANALYTICS_FILTER_DIMENSIONS)[number];

export type AnalyticsFilters = Readonly<Record<AnalyticsFilterDimension, readonly string[]>>;

export type RequestEvent = v.InferOutput<typeof RequestEventSchema>;

export type DownstreamRequest = v.InferOutput<typeof DownstreamRequestSchema>;

export type RequestList = v.InferOutput<typeof RequestListSchema>;

export type ProjectList = v.InferOutput<typeof ProjectListSchema>;

export type SessionList = v.InferOutput<typeof SessionListSchema>;

export const ANALYTICS_RANGES = [1, 7, 30, 90] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_DAYS: AnalyticsRange = 30;

/**
 * A window's shape, derived from its span once so the server and the chart cannot disagree. One day
 * reads hour by hour, or the chart would be a single bar.
 */
export function analyticsWindow(days: number): {
  readonly granularity: AnalyticsGranularity;
  readonly bucketCount: number;
} {
  return days === 1
    ? { granularity: "hour", bucketCount: 24 }
    : { granularity: "day", bucketCount: days };
}

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
