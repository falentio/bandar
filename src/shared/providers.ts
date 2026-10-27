import * as v from "valibot";
import { ProviderUsageSchema } from "./analytics";
import { SlugSchema, TAG_REF_PREFIX, TAG_SLUG } from "./slugs";

// Generic wires are the kinds a user can add as a custom provider.
export const GENERIC_PROVIDER_KINDS = ["openai", "anthropic", "google"] as const;

// Built-in providers come from code, exist for every account, and are not added by hand.
export const BUILT_IN_PROVIDER_KINDS = ["kilocode"] as const;

export const PROVIDER_KINDS = [...GENERIC_PROVIDER_KINDS, ...BUILT_IN_PROVIDER_KINDS] as const;

export const OAUTH_PROVIDER_KINDS = ["kilocode"] as const;

export const PROVIDER_AUTH_MODES = ["api-key", "oauth"] as const;

export const PROVIDER_ORIGINS = ["builtin", "custom"] as const;

export type BuiltInProviderKind = (typeof BUILT_IN_PROVIDER_KINDS)[number];

export const BUILT_IN_PROVIDERS = {
  kilocode: {
    kind: "kilocode",
    name: "Kilo Code",
    slug: "kilo",
    baseUrl: "https://api.kilo.ai/api/openrouter",
  },
} satisfies Record<
  BuiltInProviderKind,
  {
    readonly kind: BuiltInProviderKind;
    readonly name: string;
    readonly slug: string;
    readonly baseUrl: string;
  }
>;

export const RESERVED_PROVIDER_SLUGS: ReadonlySet<string> = new Set([
  TAG_SLUG,
  ...BUILT_IN_PROVIDER_KINDS.map((kind) => BUILT_IN_PROVIDERS[kind].slug),
]);

export const ProviderKindSchema = v.picklist(PROVIDER_KINDS);

export const GenericProviderKindSchema = v.picklist(GENERIC_PROVIDER_KINDS);

export const ProviderAuthModeSchema = v.picklist(PROVIDER_AUTH_MODES);

export const ProviderOriginSchema = v.picklist(PROVIDER_ORIGINS);

export const ProviderModelSchema = v.object({
  id: v.string(),
  upstreamModel: v.string(),
  alias: v.string(),
  ref: v.string(),
  shadowed: v.boolean(),
  inputPricePerMtok: v.nullable(v.number()),
  outputPricePerMtok: v.nullable(v.number()),
});

export const ProviderSchema = v.object({
  id: v.string(),
  name: v.string(),
  slug: v.string(),
  kind: ProviderKindSchema,
  origin: ProviderOriginSchema,
  baseUrl: v.string(),
  authMode: ProviderAuthModeSchema,
  hasKey: v.boolean(),
  models: v.array(ProviderModelSchema),
  createdAt: v.string(),
});

export const ProviderListSchema = v.object({
  providers: v.array(ProviderSchema),
});

export const ProviderDetailSchema = v.object({
  provider: ProviderSchema,
  usage: ProviderUsageSchema,
});

export const ProviderModelInputSchema = v.pipe(
  v.object({
    upstreamModel: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
    alias: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
    inputPricePerMtok: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
    outputPricePerMtok: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  }),
  v.check(
    (input) => !(input.alias ?? input.upstreamModel).startsWith(TAG_REF_PREFIX),
    `an alias cannot start with ${TAG_REF_PREFIX}`,
  ),
);

export const ProviderInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  kind: ProviderKindSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.url()),
  apiKey: v.optional(v.pipe(v.string(), v.maxLength(500)), ""),
  slug: v.optional(SlugSchema),
});

export const ProviderCreateInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  kind: GenericProviderKindSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.url()),
  apiKey: v.optional(v.pipe(v.string(), v.maxLength(500)), ""),
});

export const ProviderParamsSchema = v.object({ id: v.string() });

export const ProviderOAuthStartSchema = v.object({
  userCode: v.string(),
  verificationUrl: v.string(),
  expiresInSeconds: v.number(),
});

export const ProviderOAuthPollSchema = v.object({
  state: v.picklist(["pending", "connected"]),
  authMode: v.optional(ProviderAuthModeSchema),
});

export const ProviderModelRefreshSchema = v.object({
  added: v.number(),
  skipped: v.number(),
});

export const ProviderModelParamsSchema = v.object({ id: v.string(), modelId: v.string() });

export const providerPaths = {
  list: "/api/providers",
  detail: (id: string) => `/api/providers/${id}`,
  update: (id: string) => `/api/providers/${id}`,
  remove: (id: string) => `/api/providers/${id}`,
  oauthStart: (id: string) => `/api/providers/${id}/oauth/start`,
  oauthPoll: (id: string) => `/api/providers/${id}/oauth/poll`,
  models: (id: string) => `/api/providers/${id}/models`,
  refreshModels: (id: string) => `/api/providers/${id}/models/refresh`,
  model: (id: string, modelId: string) => `/api/providers/${id}/models/${modelId}`,
};

export type ProviderKind = v.InferOutput<typeof ProviderKindSchema>;

export type GenericProviderKind = v.InferOutput<typeof GenericProviderKindSchema>;

export type OAuthProviderKind = (typeof OAUTH_PROVIDER_KINDS)[number];

export type ProviderAuthMode = v.InferOutput<typeof ProviderAuthModeSchema>;

export type ProviderOAuthStart = v.InferOutput<typeof ProviderOAuthStartSchema>;

export type ProviderOAuthPoll = v.InferOutput<typeof ProviderOAuthPollSchema>;

export type ProviderModelRefresh = v.InferOutput<typeof ProviderModelRefreshSchema>;

export type ProviderModel = v.InferOutput<typeof ProviderModelSchema>;

export type Provider = v.InferOutput<typeof ProviderSchema>;

export type ProviderList = v.InferOutput<typeof ProviderListSchema>;

export type ProviderDetail = v.InferOutput<typeof ProviderDetailSchema>;

export type ProviderInput = v.InferOutput<typeof ProviderInputSchema>;

export type ProviderCreateInput = v.InferOutput<typeof ProviderCreateInputSchema>;

export type ProviderOrigin = v.InferOutput<typeof ProviderOriginSchema>;

export type ProviderModelInput = v.InferOutput<typeof ProviderModelInputSchema>;

export type ProviderModelParams = v.InferOutput<typeof ProviderModelParamsSchema>;
