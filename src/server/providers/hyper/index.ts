import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { bearerAdapter } from "../openai/compatible";
import { always, type BuiltInProviderDefinition } from "../types";
import { fetchHyperCatalog } from "./catalog";

const settings = BUILT_IN_PROVIDERS.hyper;

export const hyper: BuiltInProviderDefinition<"hyper"> = {
  kind: "hyper",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
  },
  routes: { chat: { adapter: bearerAdapter("hyper", "hyper") } },
  defaultCompat: always("chat"),
  catalog: fetchHyperCatalog,
};
