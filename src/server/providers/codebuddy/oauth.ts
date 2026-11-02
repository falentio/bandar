import * as v from "valibot";
import { joinUrl, postJson } from "../http";
import { UpstreamError } from "../types";
import type { ConnectorInput, DeviceLogin, DevicePollResult, OAuthConnector } from "../types";

const LOGIN_EXPIRES_SECONDS = 300;
const LOGIN_INTERVAL_SECONDS = 2;
const PENDING_CODE = 11217;

const NO_AUTH_HEADERS = {
  "x-no-authorization": "true",
  "x-no-user-id": "true",
  "x-no-enterprise-id": "true",
  "x-no-department-info": "true",
};

const StateEnvelopeSchema = v.object({
  code: v.number(),
  data: v.optional(v.nullable(v.object({ state: v.string(), authUrl: v.string() })), null),
});

const TokenBundleSchema = v.object({
  accessToken: v.string(),
  refreshToken: v.optional(v.nullable(v.string()), null),
  expiresIn: v.optional(v.nullable(v.number()), null),
  expiresAt: v.optional(v.nullable(v.number()), null),
});

const TokenEnvelopeSchema = v.object({
  code: v.number(),
  msg: v.optional(v.nullable(v.string()), null),
  data: v.optional(v.nullable(TokenBundleSchema), null),
});

const AccountEnvelopeSchema = v.object({
  code: v.number(),
  data: v.optional(v.nullable(v.object({ uid: v.optional(v.nullable(v.string()), null) })), null),
});

export type TokenBundle = v.InferOutput<typeof TokenBundleSchema>;

export const codebuddyConnector: OAuthConnector = {
  async start({ authUrl, signal }: ConnectorInput): Promise<DeviceLogin> {
    const response = await postJson({
      url: pluginUrl(authUrl, "auth/state?platform=CLI"),
      headers: NO_AUTH_HEADERS,
      body: "{}",
      signal,
    });

    if (!response.ok) {
      throw new UpstreamError(
        `the CodeBuddy login failed (${String(response.status)})`,
        "unavailable",
        response.status,
      );
    }

    const parsed = v.safeParse(StateEnvelopeSchema, await response.json().catch(() => null));

    if (!parsed.success || parsed.output.code !== 0 || parsed.output.data === null) {
      throw new UpstreamError("the CodeBuddy login returned no state", "protocol");
    }

    return {
      code: parsed.output.data.state,
      userCode: null,
      verificationUrl: parsed.output.data.authUrl,
      expiresInSeconds: LOGIN_EXPIRES_SECONDS,
      intervalSeconds: LOGIN_INTERVAL_SECONDS,
    };
  },

  async poll(code: string, { authUrl, signal }: ConnectorInput): Promise<DevicePollResult> {
    const url = pluginUrl(authUrl, `auth/token?state=${encodeURIComponent(code)}`);

    const response = await fetch(url, { headers: NO_AUTH_HEADERS, signal }).catch(
      (error: Error) => {
        throw new UpstreamError(`the CodeBuddy login poll failed: ${error.message}`, "network");
      },
    );

    if (!response.ok) {
      throw new UpstreamError(
        `the CodeBuddy login failed (${String(response.status)})`,
        "unavailable",
        response.status,
      );
    }

    const envelope = await readTokenEnvelope(response);

    if (envelope.code === PENDING_CODE) return { state: "pending" };

    if (envelope.code !== 0 || envelope.data === null) {
      throw new UpstreamError(
        `the CodeBuddy login was rejected${reasonOf(envelope.msg)}`,
        "invalid_request",
      );
    }

    const accessToken = envelope.data.accessToken;

    return {
      state: "connected",
      credential: {
        authMode: "oauth",
        accessToken,
        organizationId: await accountOf(accessToken, authUrl, signal),
        refreshToken: envelope.data.refreshToken,
        expiresAt: expiresAtOf(envelope.data),
      },
    };
  },
};

export function pluginUrl(authUrl: string, path: string): string {
  return joinUrl(authUrl, `v2/plugin/${path}`);
}

export async function readTokenEnvelope(
  response: Response,
): Promise<v.InferOutput<typeof TokenEnvelopeSchema>> {
  const parsed = v.safeParse(TokenEnvelopeSchema, await response.json().catch(() => null));

  if (!parsed.success)
    throw new UpstreamError("the CodeBuddy server returned no token bundle", "protocol");

  return parsed.output;
}

export function expiresAtOf(bundle: TokenBundle): number | null {
  return bundle.expiresIn === null ? bundle.expiresAt : Date.now() + bundle.expiresIn * 1000;
}

export function reasonOf(message: string | null): string {
  return message === null || message === "" ? "" : ` (${message})`;
}

async function accountOf(
  token: string,
  authUrl: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(pluginUrl(authUrl, "account"), {
    headers: { authorization: `Bearer ${token}` },
    signal,
  }).catch(() => null);

  if (response === null || !response.ok) return null;

  const parsed = v.safeParse(AccountEnvelopeSchema, await response.json().catch(() => null));

  if (!parsed.success || parsed.output.code !== 0) return null;

  return parsed.output.data?.uid ?? null;
}
