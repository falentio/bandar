import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { apiBaseUrl } from "../env";
import type { BuiltInProviderDefinition } from "../types";
import { opencodeAdapter } from "./adapter";
import { fetchOpenCodeCatalog } from "./catalog";

const settings = BUILT_IN_PROVIDERS.opencode;

export const opencode: BuiltInProviderDefinition<"opencode"> = {
  kind: "opencode",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_OPENCODE_API", settings.baseUrl, "/inference"),
  },
  adapter: opencodeAdapter,
  catalog: fetchOpenCodeCatalog,
};
