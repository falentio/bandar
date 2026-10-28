import * as v from "valibot";
import type { Credential } from "../../credential";
import { originUrl } from "../env";
import { joinUrl, postForm } from "../http";
import { UpstreamError } from "../types";
import type { DeviceLogin, DevicePollResult, OAuthConnector } from "../types";

const PORTAL = "https://portal.nousresearch.com";
export const CLIENT_ID = "hermes-cli";
const SCOPE = "inference:invoke";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DeviceCodeSchema = v.object({
  device_code: v.string(),
  user_code: v.string(),
  verification_uri: v.string(),
  verification_uri_complete: v.optional(v.nullable(v.string())),
  expires_in: v.number(),
  interval: v.optional(v.number()),
});

const TokenSchema = v.object({
  access_token: v.string(),
  refresh_token: v.optional(v.nullable(v.string())),
  token_type: v.optional(v.string()),
  expires_in: v.number(),
});

const FailureSchema = v.object({ error: v.string() });

const PENDING = new Set(["authorization_pending", "slow_down"]);
const TERMINAL = new Set(["expired_token", "access_denied"]);

export async function oauthFailureReason(response: Response): Promise<string> {
  const failure = v.safeParse(FailureSchema, await response.json().catch(() => null));

  return failure.success ? failure.output.error : "";
}

export const nousConnector: OAuthConnector = {
  async start(signal: AbortSignal): Promise<DeviceLogin> {
    const response = await postForm({
      url: portalUrl("api/oauth/device/code"),
      headers: {},
      form: { client_id: CLIENT_ID, scope: SCOPE },
      signal,
    });

    if (!response.ok) {
      throw new UpstreamError(
        `the Nous Portal login failed (${response.status})`,
        "unavailable",
        response.status,
      );
    }

    const parsed = v.safeParse(DeviceCodeSchema, await response.json().catch(() => null));

    if (!parsed.success)
      throw new UpstreamError("the Nous Portal returned no login code", "protocol");

    return {
      code: parsed.output.device_code,
      userCode: parsed.output.user_code,
      verificationUrl: parsed.output.verification_uri_complete ?? parsed.output.verification_uri,
      expiresInSeconds: parsed.output.expires_in,
      intervalSeconds: Math.max(1, parsed.output.interval ?? 5),
    };
  },

  async poll(code: string, signal: AbortSignal): Promise<DevicePollResult> {
    const response = await postForm({
      url: portalUrl("api/oauth/token"),
      headers: {},
      form: { grant_type: DEVICE_GRANT, client_id: CLIENT_ID, device_code: code },
      signal,
    });

    if (response.status === 400) {
      const reason = await oauthFailureReason(response);

      if (PENDING.has(reason)) return { state: "pending" };

      throw new UpstreamError(
        TERMINAL.has(reason)
          ? "the Nous Portal login expired; start again"
          : `the Nous Portal rejected the login${reason === "" ? "" : ` (${reason})`}`,
        "invalid_request",
        response.status,
      );
    }

    if (!response.ok) {
      throw new UpstreamError(
        `the Nous Portal login failed (${response.status})`,
        "unavailable",
        response.status,
      );
    }

    return { state: "connected", credential: await credentialOf(response) };
  },
};

export function portalUrl(path: string): string {
  return joinUrl(originUrl("BANDAR_NOUS_PORTAL", PORTAL), path);
}

export async function credentialOf(response: Response): Promise<Credential> {
  const parsed = v.safeParse(TokenSchema, await response.json().catch(() => null));

  if (!parsed.success) throw new UpstreamError("the Nous Portal returned no token", "protocol");

  return {
    authMode: "oauth",
    accessToken: parsed.output.access_token,
    organizationId: null,
    refreshToken: parsed.output.refresh_token ?? null,
    expiresAt: Date.now() + parsed.output.expires_in * 1000,
  };
}
