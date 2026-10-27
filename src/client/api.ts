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
  AnalyticsSchema,
  RequestListSchema,
  analyticsPaths,
  type Analytics,
  type RequestList,
} from "../shared/analytics";
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
  ProviderInputSchema,
  ProviderListSchema,
  ProviderSchema,
  providerPaths,
  type Provider,
  type ProviderInput,
  type ProviderList,
} from "../shared/providers";

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
  create: (input: ProviderInput): Promise<Provider> =>
    request(providerPaths.list, ProviderSchema, {
      method: "POST",
      body: JSON.stringify(v.parse(ProviderInputSchema, input)),
    }),
  remove: async (id: string): Promise<void> => {
    await send(providerPaths.remove(id), { method: "DELETE" });
  },
};

export const analyticsApi = {
  overview: (days: number): Promise<Analytics> =>
    request(`${analyticsPaths.analytics}?days=${days}`, AnalyticsSchema),
  requests: (limit = 50): Promise<RequestList> =>
    request(`${analyticsPaths.requests}?limit=${limit}`, RequestListSchema),
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
