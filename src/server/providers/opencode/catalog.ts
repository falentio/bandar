import { entryOf, readPublicModelIds } from "../catalog";
import { joinUrl } from "../http";
import type { CatalogRequest, ModelCatalogEntry } from "../types";
import { OPENCODE_MOUNTS } from "./compat";
import { OPENCODE_MODELS } from "./models";

/** The servable models among the ids the gateway lists, priced from the table. */
export function opencodeEntries(listed: readonly string[]): readonly ModelCatalogEntry[] {
  const listedIds = new Set(listed);

  return OPENCODE_MODELS.flatMap((model) => {
    if (model.compat === null || !listedIds.has(model.id)) return [];

    return [entryOf(model.id, model.prices)];
  });
}

export async function fetchOpenCodeCatalog(
  request: CatalogRequest,
): Promise<readonly ModelCatalogEntry[]> {
  const listed = await readPublicModelIds({
    ...request,
    baseUrl: joinUrl(request.baseUrl, OPENCODE_MOUNTS.models),
  });

  return opencodeEntries(listed);
}
