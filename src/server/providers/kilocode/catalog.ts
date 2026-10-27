import * as v from "valibot";
import { UpstreamError } from "../types";
import type { ModelCatalogEntry } from "../types";

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
            completion: v.optional(PriceSchema),
          }),
        ),
      ),
    }),
  ),
});

export async function fetchKilocodeCatalog(
  signal: AbortSignal,
): Promise<readonly ModelCatalogEntry[]> {
  const url = Bun.env.BANDAR_KILOCODE_MODELS_URL ?? KILO_MODELS_URL;

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
        inputPricePerMtok: pricePerMtok(model.pricing?.prompt),
        outputPricePerMtok: pricePerMtok(model.pricing?.completion),
      },
    ];
  });
}

function aliasFor(upstreamModel: string): string {
  return upstreamModel.replace(/:free$/, "");
}

function pricePerMtok(value: string | number | undefined): number | null {
  if (value === undefined) return null;

  const perToken = Number(value);

  // Kilo reports `-1` for a model it routes dynamically, and 0 for a free one.
  if (!Number.isFinite(perToken) || perToken < 0) return null;

  return perToken * 1_000_000;
}
