import * as v from "valibot";

export const PROVIDER_KINDS = ["openai", "anthropic", "google"] as const;

export const ProviderKindSchema = v.picklist(PROVIDER_KINDS);

export const ProviderModelSchema = v.object({
  id: v.string(),
  upstreamModel: v.string(),
  alias: v.string(),
  inputPricePerMtok: v.nullable(v.number()),
  outputPricePerMtok: v.nullable(v.number()),
});

export const ProviderSchema = v.object({
  id: v.string(),
  name: v.string(),
  kind: ProviderKindSchema,
  baseUrl: v.string(),
  hasKey: v.boolean(),
  models: v.array(ProviderModelSchema),
  createdAt: v.string(),
});

export const ProviderListSchema = v.object({
  providers: v.array(ProviderSchema),
});

export const ProviderModelInputSchema = v.object({
  upstreamModel: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  alias: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
  inputPricePerMtok: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  outputPricePerMtok: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
});

export const ProviderInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  kind: ProviderKindSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.url()),
  apiKey: v.optional(v.pipe(v.string(), v.maxLength(500)), ""),
});

export const ProviderParamsSchema = v.object({ id: v.string() });

export const ProviderModelParamsSchema = v.object({ id: v.string(), modelId: v.string() });

export const providerPaths = {
  list: "/api/providers",
  update: (id: string) => `/api/providers/${id}`,
  remove: (id: string) => `/api/providers/${id}`,
  models: (id: string) => `/api/providers/${id}/models`,
  model: (id: string, modelId: string) => `/api/providers/${id}/models/${modelId}`,
};

export type ProviderKind = v.InferOutput<typeof ProviderKindSchema>;

export type ProviderModel = v.InferOutput<typeof ProviderModelSchema>;

export type Provider = v.InferOutput<typeof ProviderSchema>;

export type ProviderList = v.InferOutput<typeof ProviderListSchema>;

export type ProviderInput = v.InferOutput<typeof ProviderInputSchema>;

export type ProviderModelInput = v.InferOutput<typeof ProviderModelInputSchema>;

export type ProviderModelParams = v.InferOutput<typeof ProviderModelParamsSchema>;
