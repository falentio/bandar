import type { Credential } from "../../credential";
import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { secretOf, type WireHeaders } from "../http";
import { chatAdapter } from "../openai/compatible";
import { always, type BuiltInProviderDefinition } from "../types";
import { fetchCodebuddyCatalog } from "./models";
import { codebuddyConnector } from "./oauth";
import { codebuddyRenewal } from "./renewal";

const settings = BUILT_IN_PROVIDERS.codebuddy;

// The endpoint answers a chat without all three ids as code 11128.
function conversationHeaders(): WireHeaders {
  return {
    "x-conversation-id": crypto.randomUUID(),
    "x-conversation-request-id": crypto.randomUUID(),
    "x-conversation-message-id": crypto.randomUUID(),
  };
}

export const codebuddy: BuiltInProviderDefinition<"codebuddy"> = {
  kind: "codebuddy",
  // A pasted access token is the CLI's own CODEBUDDY_API_KEY, so both modes reach one bearer.
  authModes: ["oauth", "api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
  },
  routes: {
    chat: {
      adapter: chatAdapter({ kind: "codebuddy", label: "codebuddy", headers: codebuddyHeaders }),
    },
  },
  defaultCompat: always("chat"),
  oauth: codebuddyConnector,
  catalog: fetchCodebuddyCatalog,
  renew: codebuddyRenewal,
};

function codebuddyHeaders(credential: Credential): WireHeaders {
  const secret = secretOf(credential);
  const uid = credential.authMode === "oauth" ? credential.organizationId : null;

  const headers: WireHeaders = {
    ...conversationHeaders(),
    authorization: "Bearer " + secret,
  };

  if (uid === null) return headers;

  return {
    ...headers,
    "x-user-id": uid,
    "x-userinfo": Buffer.from(JSON.stringify({ uin: uid }), "utf8").toString("base64"),
  };
}
