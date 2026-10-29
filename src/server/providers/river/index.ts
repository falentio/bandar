import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { bearerAdapter } from "../openai/compatible";
import { always, type BuiltInProviderDefinition } from "../types";
import { fetchRiverCatalog } from "./catalog";

const settings = BUILT_IN_PROVIDERS.river;

export const river: BuiltInProviderDefinition<"river"> = {
  kind: "river",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
  },
  routes: { chat: { adapter: bearerAdapter("river") } },
  defaultCompat: always("chat"),
  catalog: fetchRiverCatalog,
};
