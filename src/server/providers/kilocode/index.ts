import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { apiBaseUrl } from "../env";
import { always, type BuiltInProviderDefinition } from "../types";
import { kilocodeAdapter } from "./adapter";
import { fetchKilocodeCatalog } from "./catalog";
import { kilocodeConnector } from "./oauth";

const settings = BUILT_IN_PROVIDERS.kilocode;

export const kilocode: BuiltInProviderDefinition<"kilocode"> = {
  kind: "kilocode",
  // A device login and a pasted API key reach the same bearer header, so the
  // dialog offers both and the chain can fall from one to the other.
  authModes: ["api-key", "oauth"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_KILOCODE_API", settings.baseUrl, "/api/openrouter"),
  },
  routes: { chat: { adapter: kilocodeAdapter } },
  defaultCompat: always("chat"),
  oauth: kilocodeConnector,
  catalog: fetchKilocodeCatalog,
};
