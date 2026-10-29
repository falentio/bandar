import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { anthropicAdapter } from "../anthropic/adapter";
import { bearerHeaders } from "../http";
import { bearerAdapter } from "../openai/compatible";
import { always, type BuiltInProviderDefinition } from "../types";
import { fetchZroCatalog } from "./catalog";

const settings = BUILT_IN_PROVIDERS.zro;

export const zro: BuiltInProviderDefinition<"zro"> = {
  kind: "zro",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
  },
  routes: {
    chat: { adapter: bearerAdapter("zro") },
    messages: {
      adapter: anthropicAdapter({ kind: "zro", label: "zro", headers: bearerHeaders }),
    },
  },
  defaultCompat: always("chat"),
  catalog: fetchZroCatalog,
};
