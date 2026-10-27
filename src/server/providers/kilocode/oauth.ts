import * as v from "valibot";
import { UpstreamError } from "../../router/types";
import type { DeviceLogin, DevicePollResult, OAuthConnector } from "../types";

const DeviceLoginSchema = v.object({
  code: v.string(),
  user_code: v.string(),
  verificationUrl: v.string(),
  expiresIn: v.optional(v.number(), 600),
});

const PendingSchema = v.object({ status: v.literal("pending") });
const ApprovedSchema = v.object({ status: v.literal("approved"), token: v.string() });

const ProfileSchema = v.object({
  organizations: v.optional(v.array(v.object({ id: v.string() }))),
});

// The smoke run points this at a local fake so the device flow runs end to end.
const KILO_API = Bun.env.BANDAR_KILOCODE_API ?? "https://api.kilo.ai";

export const kilocodeConnector: OAuthConnector = {
  async start(signal: AbortSignal): Promise<DeviceLogin> {
    const response = await fetch(`${KILO_API}/api/device-auth/codes`, {
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
    };
  },

  async poll(code: string, signal: AbortSignal): Promise<DevicePollResult> {
    const response = await fetch(`${KILO_API}/api/device-auth/codes/${encodeURIComponent(code)}`, {
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
        organizationId: await organizationOf(approved.output.token, signal),
      },
    };
  },
};

async function organizationOf(token: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${KILO_API}/api/profile`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  }).catch(() => null);

  if (response === null || !response.ok) return null;

  const parsed = v.safeParse(ProfileSchema, await response.json().catch(() => null));

  return parsed.success ? (parsed.output.organizations?.[0]?.id ?? null) : null;
}
