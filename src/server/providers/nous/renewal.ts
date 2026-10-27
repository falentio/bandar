import type { Credential } from "../../credential";
import { postForm } from "../http";
import { UpstreamError, type CredentialRenewer } from "../types";
import { CLIENT_ID, credentialOf, oauthFailureReason, portalUrl } from "./oauth";

const REFRESH_SKEW_MS = 120_000;

export const nousRenewal: CredentialRenewer = {
  due(credential, now) {
    return credential.expiresAt !== null && credential.expiresAt - now <= REFRESH_SKEW_MS;
  },

  async renew({ credential, signal }): Promise<Credential> {
    if (credential.refreshToken === null) {
      throw new UpstreamError("the Nous Portal connection expired; connect it again", "auth");
    }

    const response = await postForm({
      url: portalUrl("api/oauth/token"),
      headers: { "x-nous-refresh-token": credential.refreshToken },
      form: { grant_type: "refresh_token", client_id: CLIENT_ID },
      signal,
    });

    if (response.status === 400) {
      const reason = await oauthFailureReason(response);

      throw new UpstreamError(
        reason === "invalid_grant"
          ? "the Nous Portal connection expired; connect it again"
          : `the Nous Portal rejected the renewal${reason === "" ? "" : ` (${reason})`}`,
        "auth",
        response.status,
      );
    }

    if (!response.ok) {
      throw new UpstreamError(
        `the Nous Portal renewal failed (${response.status})`,
        "unavailable",
        response.status,
      );
    }

    return credentialOf(response);
  },
};
