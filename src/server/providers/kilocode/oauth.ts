import * as v from "valibot";
import { UpstreamError } from "../types";
import type { ConnectorInput, DeviceLogin, DevicePollResult, OAuthConnector } from "../types";

const DeviceLoginSchema = v.object({
  code: v.string(),
  user_code: v.string(),
  verificationUrl: v.string(),
  expiresIn: v.optional(v.number(), 600),
  interval: v.optional(v.number(), 5),
});

const PendingSchema = v.object({ status: v.literal("pending") });
const ApprovedSchema = v.object({ status: v.literal("approved"), token: v.string() });

const ProfileSchema = v.object({
  organizations: v.optional(v.array(v.object({ id: v.string() }))),
});

export const kilocodeConnector: OAuthConnector = {
  async start({ authUrl, signal }: ConnectorInput): Promise<DeviceLogin> {
    const response = await fetch(`${authUrl}/api/device-auth/codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
    }).catch((error: Error) => {
      throw new UpstreamError(`kilo code login failed: ${error.message}`, "network");
    });

    if (!response.ok) {
      throw new UpstreamError(
        `kilo code login failed (${response.status})`,
        "unavailable",
        response.status,
      );
    }

    const parsed = v.safeParse(DeviceLoginSchema, await response.json());

    if (!parsed.success) throw new UpstreamError("kilo code returned no login code", "protocol");

    return {
      code: parsed.output.code,
      userCode: parsed.output.user_code,
      verificationUrl: parsed.output.verificationUrl,
      expiresInSeconds: parsed.output.expiresIn,
      intervalSeconds: Math.max(1, parsed.output.interval),
    };
  },

  async poll(code: string, { authUrl, signal }: ConnectorInput): Promise<DevicePollResult> {
    const response = await fetch(`${authUrl}/api/device-auth/codes/${encodeURIComponent(code)}`, {
      signal,
    }).catch((error: Error) => {
      throw new UpstreamError(`kilo code login poll failed: ${error.message}`, "network");
    });

    if (response.status === 202) {
      const pending = v.safeParse(PendingSchema, await response.json());

      if (!pending.success)
        throw new UpstreamError("kilo code returned an odd poll answer", "protocol");

      return { state: "pending" };
    }

    if (!response.ok) {
      const message =
        response.status === 410
          ? "the kilo code login code expired; start again"
          : `kilo code login poll failed (${response.status})`;

      throw new UpstreamError(
        message,
        response.status === 410 ? "invalid_request" : "unavailable",
        response.status,
      );
    }

    const approved = v.safeParse(ApprovedSchema, await response.json());

    if (!approved.success) throw new UpstreamError("kilo code returned no token", "protocol");

    return {
      state: "connected",
      credential: {
        authMode: "oauth",
        accessToken: approved.output.token,
        organizationId: await organizationOf(approved.output.token, authUrl, signal),
        refreshToken: null,
        expiresAt: null,
      },
    };
  },
};

async function organizationOf(
  token: string,
  authUrl: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(`${authUrl}/api/profile`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  }).catch(() => null);

  if (response === null || !response.ok) return null;

  const parsed = v.safeParse(ProfileSchema, await response.json().catch(() => null));

  return parsed.success ? (parsed.output.organizations?.[0]?.id ?? null) : null;
}
