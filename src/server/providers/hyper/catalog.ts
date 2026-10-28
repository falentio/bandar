import * as v from "valibot";
import { entryOf, fromPerMtok, readPublicModelResponse } from "../catalog";
import type { CatalogRequest, ModelCatalogEntry } from "../types";
import { UpstreamError } from "../types";

const AmountSchema = v.union([v.number(), v.string()]);

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

export async function fetchHyperCatalog(
  request: CatalogRequest,
): Promise<readonly ModelCatalogEntry[]> {
  const response = await readPublicModelResponse(request);
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
