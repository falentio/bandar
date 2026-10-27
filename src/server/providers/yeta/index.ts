import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { entryOf, NO_PRICE, readModelIds } from "../catalog";
import { apiBaseUrl } from "../env";
import { bearerAdapter } from "../openai/compatible";
import type { BuiltInProviderDefinition, CatalogRequest, ModelCatalogEntry } from "../types";
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
  adapter: bearerAdapter("yeta"),
  catalog: fetchYetaCatalog,
};

async function fetchYetaCatalog(request: CatalogRequest): Promise<readonly ModelCatalogEntry[]> {
  const ids = await readModelIds(request);

  // Prices are metadata: a failed join leaves the models unpriced rather than unimported.
  const prices = await fetchYetaPricing(request).catch(() => null);

  return ids.map((id) => entryOf(id, prices?.get(id) ?? NO_PRICE));
}
