import * as v from "valibot";
import { ProviderUsageSchema } from "./analytics";
import { MAX_UPSTREAM_MODEL_LENGTH, SlugSchema, TAG_REF_PREFIX } from "./slugs";

// Generic wires are the kinds a user can add as a custom provider.
export const GENERIC_PROVIDER_KINDS = ["openai", "anthropic", "google"] as const;

// Built-in providers come from code, exist for every account, and are not added by hand.
export const BUILT_IN_PROVIDER_KINDS = [
  "kilocode",
  "tokenharbor",
  "yeta",
  "river",
  "nous",
  "hyper",
  "opencode",
] as const;

export const PROVIDER_KINDS = [...GENERIC_PROVIDER_KINDS, ...BUILT_IN_PROVIDER_KINDS] as const;

export const PROVIDER_AUTH_MODES = ["api-key", "oauth"] as const;

export const PROVIDER_ORIGINS = ["builtin", "custom"] as const;

// A compatibility is the wire a model answers on, independent of the kind that reaches it.
export const COMPATIBILITIES = ["chat", "responses", "messages", "genai"] as const;

export type BuiltInProviderKind = (typeof BUILT_IN_PROVIDER_KINDS)[number];

export type Compat = (typeof COMPATIBILITIES)[number];

export const BUILT_IN_PROVIDERS = {
  kilocode: {
    kind: "kilocode",
    name: "Kilo Code",
    slug: "kilo",
    baseUrl: "https://api.kilo.ai/api/openrouter",
  },
  tokenharbor: {
    kind: "tokenharbor",
    name: "Token Harbor",
    slug: "tokenharbor",
    baseUrl: "https://tokenharbor.ai/v1",
  },
  yeta: {
    kind: "yeta",
    name: "Yeta",
    slug: "yeta",
    baseUrl: "https://platform.yeta.ai/v1",
  },
  river: {
    kind: "river",
    name: "River",
    slug: "river",
    baseUrl: "https://api.river.ai/v1",
  },
  nous: {
    kind: "nous",
    name: "Nous Portal",
    slug: "nous",
    baseUrl: "https://inference-api.nousresearch.com/v1",
  },
  hyper: {
    kind: "hyper",
    name: "Hyper",
    slug: "hyper",
    baseUrl: "https://hyper.charm.land/v1",
  },
  opencode: {
    kind: "opencode",
    name: "OpenCode Go",
    slug: "opencode",
    baseUrl: "https://opencode.ai/inference",
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
  failures: v.number(),
  flaggedUntil: v.nullable(v.string()),
});

export const ProviderCredentialSchema = v.object({
  id: v.string(),
  label: v.string(),
  authMode: ProviderAuthModeSchema,
  priority: v.number(),
  failures: v.number(),
  flaggedUntil: v.nullable(v.string()),
  createdAt: v.string(),
});

export const ProviderSchema = v.object({
  id: v.string(),
  name: v.string(),
  slug: v.string(),
  kind: ProviderKindSchema,
  origin: ProviderOriginSchema,
  baseUrl: v.string(),
  authModes: v.array(ProviderAuthModeSchema),
  hasCatalog: v.boolean(),
  credentials: v.array(ProviderCredentialSchema),
  models: v.array(ProviderModelSchema),
  failures: v.number(),
  flaggedUntil: v.nullable(v.string()),
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
    upstreamModel: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(MAX_UPSTREAM_MODEL_LENGTH),
    ),
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
  slug: v.optional(SlugSchema),
});

export const MAX_API_KEY_LENGTH = 500;

export const MAX_BULK_CREDENTIALS = 100;

const ApiKeySchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_API_KEY_LENGTH));

export const ProviderCreateInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  kind: GenericProviderKindSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.url()),
  apiKey: v.optional(v.pipe(v.string(), v.maxLength(MAX_API_KEY_LENGTH)), ""),
});

export const ProviderParamsSchema = v.object({ id: v.string() });

export const ProviderCredentialParamsSchema = v.object({
  id: v.string(),
  credentialId: v.string(),
});

export const ProviderCredentialInputSchema = v.object({
  label: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60))),
  apiKey: ApiKeySchema,
});

export const ProviderCredentialBulkInputSchema = v.object({
  apiKeys: v.pipe(
    v.array(ApiKeySchema),
    v.minLength(1),
    v.maxLength(MAX_BULK_CREDENTIALS),
    v.check((apiKeys) => new Set(apiKeys).size === apiKeys.length, "list each API key once"),
  ),
});

export const ProviderCredentialOrderInputSchema = v.object({
  credentialIds: v.pipe(
    v.array(v.string()),
    v.minLength(1),
    v.maxLength(100),
    v.check((ids) => new Set(ids).size === ids.length, "list each credential once"),
  ),
});

export const ProviderCredentialProbeSchema = v.object({
  ok: v.boolean(),
  status: v.nullable(v.number()),
  latencyMs: v.number(),
  error: v.nullable(v.string()),
});

export const ProviderOAuthStartSchema = v.object({
  userCode: v.string(),
  verificationUrl: v.string(),
  expiresInSeconds: v.number(),
  intervalSeconds: v.pipe(v.number(), v.minValue(1)),
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
  credentials: (id: string) => `/api/providers/${id}/credentials`,
  credentialsBulk: (id: string) => `/api/providers/${id}/credentials/bulk`,
  credentialOrder: (id: string) => `/api/providers/${id}/credentials/order`,
  credential: (id: string, credentialId: string) =>
    `/api/providers/${id}/credentials/${credentialId}`,
  credentialTest: (id: string, credentialId: string) =>
    `/api/providers/${id}/credentials/${credentialId}/test`,
  models: (id: string) => `/api/providers/${id}/models`,
  refreshModels: (id: string) => `/api/providers/${id}/models/refresh`,
  model: (id: string, modelId: string) => `/api/providers/${id}/models/${modelId}`,
};

export type ProviderKind = v.InferOutput<typeof ProviderKindSchema>;

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI compatible",
  anthropic: "Anthropic compatible",
  google: "Google GenAI compatible",
  kilocode: BUILT_IN_PROVIDERS.kilocode.name,
  tokenharbor: BUILT_IN_PROVIDERS.tokenharbor.name,
  yeta: BUILT_IN_PROVIDERS.yeta.name,
  river: BUILT_IN_PROVIDERS.river.name,
  nous: BUILT_IN_PROVIDERS.nous.name,
  hyper: BUILT_IN_PROVIDERS.hyper.name,
  opencode: BUILT_IN_PROVIDERS.opencode.name,
};

export type GenericProviderKind = v.InferOutput<typeof GenericProviderKindSchema>;

export type ProviderAuthMode = v.InferOutput<typeof ProviderAuthModeSchema>;

export type ProviderCredentialProbe = v.InferOutput<typeof ProviderCredentialProbeSchema>;

export type ProviderOAuthStart = v.InferOutput<typeof ProviderOAuthStartSchema>;

export type ProviderOAuthPoll = v.InferOutput<typeof ProviderOAuthPollSchema>;

export type ProviderModelRefresh = v.InferOutput<typeof ProviderModelRefreshSchema>;

export type ProviderModel = v.InferOutput<typeof ProviderModelSchema>;

export type Provider = v.InferOutput<typeof ProviderSchema>;

export type ProviderCredential = v.InferOutput<typeof ProviderCredentialSchema>;

export type ProviderCredentialInput = v.InferOutput<typeof ProviderCredentialInputSchema>;

export type ProviderCredentialBulkInput = v.InferOutput<typeof ProviderCredentialBulkInputSchema>;

export type ProviderList = v.InferOutput<typeof ProviderListSchema>;

export type ProviderDetail = v.InferOutput<typeof ProviderDetailSchema>;

export type ProviderInput = v.InferOutput<typeof ProviderInputSchema>;

export type ProviderCreateInput = v.InferOutput<typeof ProviderCreateInputSchema>;

export type ProviderOrigin = v.InferOutput<typeof ProviderOriginSchema>;

export type ProviderModelInput = v.InferOutput<typeof ProviderModelInputSchema>;

export type ProviderModelParams = v.InferOutput<typeof ProviderModelParamsSchema>;
