import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import type { BuiltInProviderDefinition } from "../types";
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
    baseUrl: kilocodeBaseUrl,
  },
  adapter: kilocodeAdapter,
  oauth: kilocodeConnector,
  catalog: fetchKilocodeCatalog,
};

function kilocodeBaseUrl(): string {
  const origin = Bun.env.BANDAR_KILOCODE_API?.replace(/\/+$/, "");

  return origin === undefined ? settings.baseUrl : `${origin}/api/openrouter`;
}
