import * as v from "valibot";
import { entryOf, fromPerToken, readPublicModelResponse } from "../catalog";
import { UpstreamError } from "../types";
import type { CatalogRequest, ModelCatalogEntry } from "../types";

const AmountSchema = v.union([v.number(), v.string()]);

// The portal publishes this catalog to anyone, so the request's credential goes unused.
const CatalogSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      architecture: v.optional(
        v.nullable(v.object({ output_modalities: v.optional(v.nullable(v.array(v.string()))) })),
      ),
      pricing: v.optional(
        v.nullable(
          v.object({
            prompt: v.optional(AmountSchema),
            completion: v.optional(AmountSchema),
          }),
        ),
      ),
    }),
  ),
});

export async function fetchNousCatalog(
  request: CatalogRequest,
): Promise<readonly ModelCatalogEntry[]> {
  const response = await readPublicModelResponse(request);

  const parsed = v.safeParse(CatalogSchema, await response.json().catch(() => null));

  if (!parsed.success)
    throw new UpstreamError("the Nous Portal catalog is not readable", "protocol");

  const seen = new Set<string>();

  return parsed.output.data.flatMap((model) => {
    if (seen.has(model.id)) return [];

    if (model.architecture?.output_modalities?.includes("text") !== true) return [];

    seen.add(model.id);

    return [
      entryOf(model.id, {
        inputPricePerMtok: fromPerToken(model.pricing?.prompt),
        outputPricePerMtok: fromPerToken(model.pricing?.completion),
      }),
    ];
  });
}
