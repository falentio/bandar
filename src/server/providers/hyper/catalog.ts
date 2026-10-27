import * as v from "valibot";
import { entryOf, fromPerMtok } from "../catalog";
import { joinUrl } from "../http";
import type { CatalogRequest, ModelCatalogEntry } from "../types";
import { UpstreamError } from "../types";

const AmountSchema = v.union([v.number(), v.string()]);

// Hyper publishes this catalog to anyone, so the request's credential goes unused.
const CatalogSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      pricing: v.optional(
        v.nullable(
          v.object({
            input: v.optional(AmountSchema),
            output: v.optional(AmountSchema),
          }),
        ),
      ),
    }),
  ),
});

export async function fetchHyperCatalog({
  baseUrl,
  signal,
}: CatalogRequest): Promise<readonly ModelCatalogEntry[]> {
  const response = await fetch(joinUrl(baseUrl, "models"), { signal }).catch((error: Error) => {
    throw new UpstreamError(`could not read the Hyper catalog: ${error.message}`, "network");
  });

  if (!response.ok) {
    throw new UpstreamError(
      `could not read the Hyper catalog (${response.status})`,
      "unavailable",
      response.status,
    );
  }

  const parsed = v.safeParse(CatalogSchema, await response.json().catch(() => null));

  if (!parsed.success) throw new UpstreamError("the Hyper catalog is not readable", "protocol");

  const seen = new Set<string>();

  return parsed.output.data.flatMap((model) => {
    if (seen.has(model.id)) return [];

    seen.add(model.id);

    // Hyper quotes USD per million tokens, unlike the per-token gateways above.
    return [
      entryOf(model.id, {
        inputPricePerMtok: fromPerMtok(model.pricing?.input),
        outputPricePerMtok: fromPerMtok(model.pricing?.output),
      }),
    ];
  });
}
