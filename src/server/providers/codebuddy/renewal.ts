import { EXPIRING_CONNECTION_MS, type Credential } from "../../credential";
import { postJson } from "../http";
import { UpstreamError, type CredentialRenewer } from "../types";
import { expiresAtOf, pluginUrl, readTokenEnvelope, reasonOf } from "./oauth";

const EXPIRED = "the CodeBuddy connection expired; connect it again";

export const codebuddyRenewal: CredentialRenewer = {
  due(credential, now) {
    return credential.expiresAt !== null && credential.expiresAt - now <= EXPIRING_CONNECTION_MS;
  },

  async renew({ credential, signal, authUrl }): Promise<Credential> {
    if (credential.refreshToken === null) throw new UpstreamError(EXPIRED, "auth");

    const response = await postJson({
      url: pluginUrl(authUrl, "auth/token/refresh"),
      headers: {
        "x-refresh-token": credential.refreshToken,
        "x-auth-refresh-source": "plugin",
      },
      body: "{}",
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError(EXPIRED, "auth", response.status);
    }

    if (!response.ok) {
      throw new UpstreamError(
        `the CodeBuddy renewal failed (${String(response.status)})`,
        "unavailable",
        response.status,
      );
    }

    const envelope = await readTokenEnvelope(response);

    if (envelope.code !== 0 || envelope.data === null) {
      throw new UpstreamError(EXPIRED + reasonOf(envelope.msg), "auth", response.status);
    }

    return {
      authMode: "oauth",
      accessToken: envelope.data.accessToken,
      organizationId: credential.organizationId,
      refreshToken: envelope.data.refreshToken,
      expiresAt: expiresAtOf(envelope.data),
    };
  },
};
