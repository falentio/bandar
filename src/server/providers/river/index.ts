import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { apiBaseUrl } from "../env";
import { bearerAdapter } from "../openai/compatible";
import type { BuiltInProviderDefinition } from "../types";
import { fetchRiverCatalog } from "./catalog";

const settings = BUILT_IN_PROVIDERS.river;

export const river: BuiltInProviderDefinition<"river"> = {
  kind: "river",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_RIVER_API", settings.baseUrl),
  },
  adapter: bearerAdapter("river"),
  catalog: fetchRiverCatalog,
};
