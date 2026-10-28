import * as v from "valibot";
import { fromPerToken } from "../catalog";
import { UpstreamError } from "../types";
import type { CatalogRequest, ModelCatalogEntry } from "../types";

const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

const PriceSchema = v.union([v.string(), v.number()]);

const KiloCatalogSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      pricing: v.optional(
        v.nullable(
          v.object({
            prompt: v.optional(PriceSchema),
            input_cache_read: v.optional(PriceSchema),
            completion: v.optional(PriceSchema),
          }),
        ),
      ),
    }),
  ),
});

export async function fetchKilocodeCatalog({
  catalogUrl,
  signal,
}: CatalogRequest): Promise<readonly ModelCatalogEntry[]> {
  const url = catalogUrl ?? KILO_MODELS_URL;

  const response = await fetch(url, { signal }).catch((error: Error) => {
    throw new UpstreamError(`could not read the kilo code catalog: ${error.message}`, "network");
  });

  if (!response.ok) {
    throw new UpstreamError(
      `could not read the kilo code catalog (${response.status})`,
      "unavailable",
      response.status,
    );
  }

  const parsed = v.safeParse(KiloCatalogSchema, await response.json());

  if (!parsed.success) throw new UpstreamError("kilo code catalog is not readable", "protocol");

  const aliases = new Set<string>();
  const ids = new Set<string>();

  return parsed.output.data.flatMap((model) => {
    if (ids.has(model.id)) return [];

    ids.add(model.id);

    const base = aliasFor(model.id);
    const alias = aliases.has(base) ? model.id : base;

    aliases.add(alias);

    return [
      {
        upstreamModel: model.id,
        alias,
        inputPricePerMtok: fromPerToken(model.pricing?.prompt),
        cacheInputPricePerMtok: fromPerToken(model.pricing?.input_cache_read),
        outputPricePerMtok: fromPerToken(model.pricing?.completion),
      },
    ];
  });
}

function aliasFor(upstreamModel: string): string {
  return upstreamModel.replace(/:free$/, "");
}
