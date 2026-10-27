import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import type { BuiltInProviderDefinition } from "../types";
import { kilocodeAdapter } from "./adapter";
import { fetchKilocodeCatalog } from "./catalog";
import { kilocodeConnector } from "./oauth";

const settings = BUILT_IN_PROVIDERS.kilocode;

export const kilocode: BuiltInProviderDefinition = {
  kind: "kilocode",
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: kilocodeBaseUrl,
  },
  adapter: kilocodeAdapter,
  oauth: kilocodeConnector,
  catalog: fetchKilocodeCatalog,
};

// The smoke run points the env var at a local fake, so the origin stays configurable.
function kilocodeBaseUrl(): string {
  const origin =
    Bun.env.BANDAR_KILOCODE_API?.replace(/\/+$/, "") ?? new URL(settings.baseUrl).origin;

  return `${origin}/api/openrouter`;
}
