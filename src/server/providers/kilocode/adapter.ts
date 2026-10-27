import type { Credential } from "../../credential";
import { chatAdapter, type WireHeaders } from "../openai/compatible";
import { UpstreamError } from "../types";

export const kilocodeAdapter = chatAdapter({
  kind: "kilocode",
  label: "kilo code",
  headers: kilocodeHeaders,
});

function kilocodeHeaders(credential: Credential): WireHeaders {
  if (credential.authMode === "api-key") {
    return credential.apiKey === "" ? {} : { authorization: `Bearer ${credential.apiKey}` };
  }

  if (credential.accessToken === "") {
    throw new UpstreamError("kilo code needs a connection before it can be called", "auth");
  }

  if (credential.organizationId === null) {
    return { authorization: `Bearer ${credential.accessToken}` };
  }

  return {
    authorization: `Bearer ${credential.accessToken}`,
    "x-kilocode-organizationid": credential.organizationId,
  };
}
