import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { entryOf, readModelIds } from "../catalog";
import { apiBaseUrl } from "../env";
import { bearerAdapter } from "../openai/compatible";
import type { BuiltInProviderDefinition, CatalogRequest, ModelCatalogEntry } from "../types";

const settings = BUILT_IN_PROVIDERS.tokenharbor;

export const tokenharbor: BuiltInProviderDefinition<"tokenharbor"> = {
  kind: "tokenharbor",
  authModes: ["api-key"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_TOKENHARBOR_API", settings.baseUrl),
  },
  adapter: bearerAdapter("tokenharbor", "token harbor"),
  catalog: fetchTokenharborCatalog,
};

async function fetchTokenharborCatalog(
  request: CatalogRequest,
): Promise<readonly ModelCatalogEntry[]> {
  const ids = await readModelIds(request);

  return ids.map((id) => entryOf(id));
}
