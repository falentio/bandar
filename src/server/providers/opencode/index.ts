import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { apiBaseUrl } from "../env";
import type { BuiltInProviderDefinition } from "../types";
import { fetchOpenCodeCatalog } from "./catalog";
import { OPENCODE_ROUTES, opencodeDefaultCompat } from "./compat";

const settings = BUILT_IN_PROVIDERS.opencode;

export const opencode: BuiltInProviderDefinition<"opencode"> = {
  kind: "opencode",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_OPENCODE_API", settings.baseUrl, "/inference"),
  },
  routes: OPENCODE_ROUTES,
  defaultCompat: opencodeDefaultCompat,
  catalog: fetchOpenCodeCatalog,
};
