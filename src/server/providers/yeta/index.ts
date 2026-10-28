import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { entryOf, NO_PRICE, optionalPrices, readModelIds } from "../catalog";
import { apiBaseUrl } from "../env";
import { bearerAdapter } from "../openai/compatible";
import {
  always,
  type BuiltInProviderDefinition,
  type CatalogRequest,
  type ModelCatalogEntry,
} from "../types";
import { fetchYetaPricing } from "./pricing";

const settings = BUILT_IN_PROVIDERS.yeta;

export const yeta: BuiltInProviderDefinition<"yeta"> = {
  kind: "yeta",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_YETA_API", settings.baseUrl),
  },
  routes: { chat: { adapter: bearerAdapter("yeta") } },
  defaultCompat: always("chat"),
  catalog: fetchYetaCatalog,
};

async function fetchYetaCatalog(request: CatalogRequest): Promise<readonly ModelCatalogEntry[]> {
  const ids = await readModelIds(request);

  const prices = await optionalPrices(fetchYetaPricing(request), request.signal);

  return ids.map((id) => entryOf(id, prices?.get(id) ?? NO_PRICE));
}
