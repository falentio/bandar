import * as v from "valibot";
import { ApiErrorBodySchema } from "../shared/api";
import {
  ApiKeyListSchema,
  CreatedApiKeySchema,
  apiKeyPaths,
  type ApiKeyCreateInput,
  type ApiKeyList,
  type CreatedApiKey,
} from "../shared/api-keys";
import {
  ANALYTICS_FILTER_DIMENSIONS,
  AnalyticsSchema,
  RequestListSchema,
  analyticsPaths,
  type Analytics,
  type AnalyticsFilters,
  type RequestList,
} from "../shared/analytics";
import { CooldownListSchema, cooldownPaths, type CooldownList } from "../shared/cooldowns";
import {
  AuthErrorSchema,
  AuthResultSchema,
  SessionSchema,
  authPaths,
  type AuthResult,
  type Session,
  type SignInInput,
  type SignUpInput,
} from "../shared/auth";
import {
  ProviderCreateInputSchema,
  ProviderCredentialBulkInputSchema,
  ProviderCredentialInputSchema,
  ProviderCredentialOrderInputSchema,
  ProviderCredentialProbeSchema,
  ProviderDetailSchema,
  ProviderInputSchema,
  ProviderListSchema,
  ProviderModelCompatInputSchema,
  ProviderModelInputSchema,
  ProviderModelRefreshSchema,
  ProviderOAuthPollSchema,
  ProviderOAuthStartSchema,
  ProviderSchema,
  providerPaths,
  type Compat,
  type Provider,
  type ProviderCreateInput,
  type ProviderCredentialInput,
  type ProviderCredentialProbe,
  type ProviderDetail,
  type ProviderInput,
  type ProviderList,
  type ProviderModelInput,
  type ProviderModelRefresh,
  type ProviderOAuthPoll,
  type ProviderOAuthStart,
} from "../shared/providers";
import {
  TagCreateInputSchema,
  TagListSchema,
  TagModelsInputSchema,
  tagPaths,
  type TagList,
} from "../shared/tags";

export class ApiError extends Error {
  readonly status: number;
  readonly issues: readonly string[];

  constructor(status: number, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

export const providerApi = {
  list: (): Promise<ProviderList> => request(providerPaths.list, ProviderListSchema),
  detail: (id: string, days: number): Promise<ProviderDetail> =>
    request(`${providerPaths.detail(id)}?days=${days}`, ProviderDetailSchema),
  create: (input: ProviderCreateInput): Promise<Provider> =>
    request(providerPaths.list, ProviderSchema, {
      method: "POST",
      body: JSON.stringify(v.parse(ProviderCreateInputSchema, input)),
    }),
  update: (id: string, input: ProviderInput): Promise<Provider> =>
    request(providerPaths.update(id), ProviderSchema, {
      method: "PUT",
      body: JSON.stringify(v.parse(ProviderInputSchema, input)),
    }),
  remove: async (id: string): Promise<void> => {
    await send(providerPaths.remove(id), { method: "DELETE" });
  },
  addCredential: (id: string, input: ProviderCredentialInput): Promise<Provider> =>
    request(providerPaths.credentials(id), ProviderSchema, {
      method: "POST",
      body: JSON.stringify(v.parse(ProviderCredentialInputSchema, input)),
    }),
  addCredentials: (id: string, apiKeys: readonly string[]): Promise<Provider> =>
    request(providerPaths.credentialsBulk(id), ProviderSchema, {
      method: "POST",
      body: JSON.stringify(v.parse(ProviderCredentialBulkInputSchema, { apiKeys })),
    }),
  reorderCredentials: (id: string, credentialIds: readonly string[]): Promise<Provider> =>
    request(providerPaths.credentialOrder(id), ProviderSchema, {
      method: "PUT",
      body: JSON.stringify(v.parse(ProviderCredentialOrderInputSchema, { credentialIds })),
    }),
  removeCredential: (id: string, credentialId: string): Promise<Provider> =>
    request(providerPaths.credential(id, credentialId), ProviderSchema, { method: "DELETE" }),
  testCredential: (id: string, credentialId: string): Promise<ProviderCredentialProbe> =>
    request(providerPaths.credentialTest(id, credentialId), ProviderCredentialProbeSchema, {
      method: "POST",
    }),
  addModel: (id: string, input: ProviderModelInput): Promise<Provider> =>
    request(providerPaths.models(id), ProviderSchema, {
      method: "POST",
      body: JSON.stringify(v.parse(ProviderModelInputSchema, input)),
    }),
  removeModel: (id: string, modelId: string): Promise<Provider> =>
    request(providerPaths.model(id, modelId), ProviderSchema, { method: "DELETE" }),
  setModelCompat: (id: string, modelId: string, compat: Compat | null): Promise<Provider> =>
    request(providerPaths.model(id, modelId), ProviderSchema, {
      method: "PUT",
      body: JSON.stringify(v.parse(ProviderModelCompatInputSchema, { compat })),
    }),
  refreshModels: (id: string): Promise<ProviderModelRefresh> =>
    request(providerPaths.refreshModels(id), ProviderModelRefreshSchema, { method: "POST" }),
  startOauth: (id: string): Promise<ProviderOAuthStart> =>
    request(providerPaths.oauthStart(id), ProviderOAuthStartSchema, { method: "POST" }),
  pollOauth: (id: string): Promise<ProviderOAuthPoll> =>
    request(providerPaths.oauthPoll(id), ProviderOAuthPollSchema, { method: "POST" }),
};

export const tagApi = {
  list: (): Promise<TagList> => request(tagPaths.list, TagListSchema),
  create: (input: { readonly slug: string }): Promise<TagList> =>
    request(tagPaths.create, TagListSchema, {
      method: "POST",
      body: JSON.stringify(v.parse(TagCreateInputSchema, input)),
    }),
  remove: (id: string): Promise<TagList> =>
    request(tagPaths.remove(id), TagListSchema, { method: "DELETE" }),
  setModels: (id: string, modelIds: readonly string[]): Promise<TagList> =>
    request(tagPaths.models(id), TagListSchema, {
      method: "PUT",
      body: JSON.stringify(v.parse(TagModelsInputSchema, { modelIds })),
    }),
};

export const analyticsApi = {
  overview: (days: number, filters: AnalyticsFilters): Promise<Analytics> => {
    const params = new URLSearchParams({ days: String(days) });

    for (const dimension of ANALYTICS_FILTER_DIMENSIONS) {
      for (const value of filters[dimension]) params.append(dimension, value);
    }

    return request(`${analyticsPaths.analytics}?${params.toString()}`, AnalyticsSchema);
  },
  requests: (limit = 50, providerId?: string): Promise<RequestList> =>
    request(
      providerId === undefined
        ? `${analyticsPaths.requests}?limit=${limit}`
        : `${analyticsPaths.requests}?limit=${limit}&providerId=${encodeURIComponent(providerId)}`,
      RequestListSchema,
    ),
};

export const cooldownApi = {
  list: (limit = 100): Promise<CooldownList> =>
    request(`${cooldownPaths.list}?limit=${limit}`, CooldownListSchema),
};

export const apiKeyApi = {
  create: (input: ApiKeyCreateInput): Promise<CreatedApiKey> =>
    request(apiKeyPaths.create, CreatedApiKeySchema, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  list: (): Promise<ApiKeyList> => request(apiKeyPaths.list, ApiKeyListSchema),
  remove: async (id: string): Promise<void> => {
    await send(apiKeyPaths.remove, { method: "POST", body: JSON.stringify({ keyId: id }) });
  },
};

export const authApi = {
  session: (): Promise<Session> => request(authPaths.session, SessionSchema),
  signUp: (input: SignUpInput): Promise<AuthResult> =>
    request(authPaths.signUp, AuthResultSchema, { method: "POST", body: JSON.stringify(input) }),
  signIn: (input: SignInInput): Promise<AuthResult> =>
    request(authPaths.signIn, AuthResultSchema, { method: "POST", body: JSON.stringify(input) }),
  signOut: async (): Promise<void> => {
    await send(authPaths.signOut, { method: "POST" });
  },
};

async function request<T>(
  path: string,
  schema: v.GenericSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await send(path, init);

  return v.parse(schema, await response.json());
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, { ...init, headers });

  if (response.ok) return response;

  const payload = await response.json().catch(() => null);
  const envelope = v.safeParse(ApiErrorBodySchema, payload);

  if (envelope.success)
    throw new ApiError(
      response.status,
      envelope.output.error.message,
      envelope.output.error.issues,
    );

  const authError = v.safeParse(AuthErrorSchema, payload);

  if (authError.success) throw new ApiError(response.status, authError.output.message);

  throw new ApiError(
    response.status,
    response.statusText || `request failed with ${response.status}`,
  );
}
