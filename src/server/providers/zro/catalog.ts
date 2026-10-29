import { entryOf, NO_PRICE, readModelIds, type ModelPrices } from "../catalog";
import type { CatalogRequest, ModelCatalogEntry } from "../types";

const ZRO_PRICES: ReadonlyMap<string, ModelPrices> = new Map([
  [
    "deepseek-v4.1-flash",
    { inputPricePerMtok: 0.3, cacheInputPricePerMtok: 0.01, outputPricePerMtok: 1.1 },
  ],
  ["glm-5.3", { inputPricePerMtok: 1.4, cacheInputPricePerMtok: 0.3, outputPricePerMtok: 4.2 }],
  [
    "glm-5.3-flash",
    { inputPricePerMtok: 0.15, cacheInputPricePerMtok: 0.04, outputPricePerMtok: 0.5 },
  ],
  [
    "dolly1-security",
    { inputPricePerMtok: 0.45, cacheInputPricePerMtok: 0.12, outputPricePerMtok: 1.5 },
  ],
  [
    "dolly2-security",
    { inputPricePerMtok: 2.1, cacheInputPricePerMtok: 0.45, outputPricePerMtok: 6.3 },
  ],
  [
    "minimax-m3.1-flash",
    { inputPricePerMtok: 0.15, cacheInputPricePerMtok: 0.012, outputPricePerMtok: 0.6 },
  ],
]);

const ZRO_PREFIX = "zro/";

function zroPricesOf(upstreamModel: string): ModelPrices {
  return ZRO_PRICES.get(upstreamModel) ?? NO_PRICE;
}

/** Zro lists one model under both its bare id and a zro/ prefix; its docs name the bare one. */
function bareId(id: string): string {
  return id.startsWith(ZRO_PREFIX) ? id.slice(ZRO_PREFIX.length) : id;
}

export function zroEntries(listed: readonly string[]): readonly ModelCatalogEntry[] {
  const ids = new Set(listed.map((id) => (listed.includes(bareId(id)) ? bareId(id) : id)));

  return [...ids].map((id) => entryOf(id, zroPricesOf(bareId(id))));
}

export async function fetchZroCatalog(
  request: CatalogRequest,
): Promise<readonly ModelCatalogEntry[]> {
  return zroEntries(await readModelIds(request));
}
