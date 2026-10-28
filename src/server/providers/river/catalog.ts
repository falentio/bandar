import * as v from "valibot";
import { entryOf, fromPerMtok, optionalPrices, readModelIds } from "../catalog";
import { UpstreamError } from "../types";
import type { CatalogRequest, ModelCatalogEntry } from "../types";

const RIVER_PRICING_URL = "https://console.river.ai/api/public/pricing";

const AmountSchema = v.union([v.number(), v.string()]);

const PricingSchema = v.object({
  inference: v.array(
    v.object({
      model: v.string(),
      input: v.optional(AmountSchema),
      cache: v.optional(AmountSchema),
      output: v.optional(AmountSchema),
    }),
  ),
});

export async function fetchRiverCatalog(
  request: CatalogRequest,
): Promise<readonly ModelCatalogEntry[]> {
  const priced = await optionalPrices(readPricing(request), request.signal);

  // The console's public pricing JSON is the model list; the keyed ids are the fallback.
  if (priced !== null) return priced;

  return (await readModelIds(request)).map((id) => entryOf(id));
}

async function readPricing(request: CatalogRequest): Promise<readonly ModelCatalogEntry[]> {
  const url = request.catalogUrl ?? RIVER_PRICING_URL;

  const response = await fetch(url, { signal: request.signal }).catch((error: Error) => {
    throw new UpstreamError(`could not read the river pricing: ${error.message}`, "network");
  });

  if (!response.ok) {
    throw new UpstreamError(
      `could not read the river pricing (${response.status})`,
      "unavailable",
      response.status,
    );
  }

  const parsed = v.safeParse(PricingSchema, await response.json().catch(() => null));

  if (!parsed.success) throw new UpstreamError("the river pricing is not readable", "protocol");

  const seen = new Set<string>();

  return parsed.output.inference.flatMap((row) => {
    if (seen.has(row.model)) return [];

    seen.add(row.model);

    return [
      entryOf(row.model, {
        inputPricePerMtok: fromPerMtok(row.input),
        cacheInputPricePerMtok: fromPerMtok(row.cache),
        outputPricePerMtok: fromPerMtok(row.output),
      }),
    ];
  });
}
