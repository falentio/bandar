import * as v from "valibot";
import { joinUrl, secretOf, type WireHeaders } from "./http";
import { UpstreamError, type CatalogRequest, type ModelCatalogEntry } from "./types";

const ModelIdsSchema = v.object({ data: v.array(v.object({ id: v.string() })) });

export type ModelPrices = {
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
};

export const NO_PRICE: ModelPrices = { inputPricePerMtok: null, outputPricePerMtok: null };

/** A keyed catalog: the model list behind the provider's bearer token. */
export async function readModelIds(request: CatalogRequest): Promise<readonly string[]> {
  const credential = await request.credential();

  if (credential === null) {
    throw new UpstreamError("add a key before importing the catalog", "invalid_request");
  }

  const response = await readModelResponse(request, {
    authorization: "Bearer " + secretOf(credential),
  });

  const parsed = v.safeParse(ModelIdsSchema, await response.json().catch(() => null));

  if (!parsed.success) throw new UpstreamError("the model catalog is not readable", "protocol");

  return [...new Set(parsed.output.data.map((model) => model.id))];
}

/** A catalog anyone may read. Never touches `request.credential`. */
export async function readPublicModelIds(request: CatalogRequest): Promise<readonly string[]> {
  const response = await readPublicModelResponse(request);
  const parsed = v.safeParse(ModelIdsSchema, await response.json().catch(() => null));

  if (!parsed.success) throw new UpstreamError("the model catalog is not readable", "protocol");

  return [...new Set(parsed.output.data.map((model) => model.id))];
}

/** A public catalog response, for a provider whose list carries more than ids. */
export async function readPublicModelResponse(request: CatalogRequest): Promise<Response> {
  return readModelResponse(request, {});
}

async function readModelResponse(request: CatalogRequest, headers: WireHeaders): Promise<Response> {
  const response = await fetch(joinUrl(request.baseUrl, "models"), {
    headers,
    signal: request.signal,
  }).catch((error: Error) => {
    throw new UpstreamError("could not read the model catalog: " + error.message, "network");
  });

  if (!response.ok) {
    throw new UpstreamError(
      "could not read the model catalog (" + response.status + ")",
      "unavailable",
      response.status,
    );
  }

  return response;
}

export function entryOf(upstreamModel: string, prices: ModelPrices = NO_PRICE): ModelCatalogEntry {
  return { upstreamModel, alias: upstreamModel, ...prices };
}

export function fromPerToken(value: string | number | undefined): number | null {
  if (value === undefined) return null;

  const perToken = Number(value);

  // A gateway reports -1 for a model it routes dynamically, and 0 for a free one.
  if (!Number.isFinite(perToken) || perToken < 0) return null;

  return perToken * 1_000_000;
}

export function fromPerMtok(value: string | number | undefined): number | null {
  if (value === undefined) return null;

  const perMtok = Number(value);

  return Number.isFinite(perMtok) && perMtok >= 0 ? perMtok : null;
}
