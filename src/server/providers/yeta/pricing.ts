import * as v from "valibot";
import { NO_PRICE, type ModelPrices } from "../catalog";
import { joinUrl } from "../http";
import { UpstreamError } from "../types";
import type { CatalogRequest } from "../types";

const AmountSchema = v.optional(v.nullable(v.union([v.number(), v.string()])));

const PricingRowSchema = v.object({
  model_name: v.string(),
  model_ratio: AmountSchema,
  completion_ratio: AmountSchema,
  quota_type: AmountSchema,
});

const PricingSchema = v.object({ data: v.array(PricingRowSchema) });

export type PricingRow = v.InferOutput<typeof PricingRowSchema>;

// New API bills in quota units of $0.002 per 1K tokens, so one ratio unit is $2 per Mtok.
const USD_PER_MTOK_PER_RATIO = 2;

export function yetaPrices(row: PricingRow): ModelPrices {
  if (numberOf(row.quota_type) === 1) return NO_PRICE;

  const input = scaled(row.model_ratio, USD_PER_MTOK_PER_RATIO);
  const output = input === null ? null : scaled(row.completion_ratio, input);

  return { inputPricePerMtok: input, outputPricePerMtok: output };
}

export async function fetchYetaPricing({
  baseUrl,
  signal,
}: CatalogRequest): Promise<ReadonlyMap<string, ModelPrices>> {
  const url = joinUrl(new URL(baseUrl).origin, "api/pricing");

  const response = await fetch(url, { signal }).catch((error: Error) => {
    throw new UpstreamError(`could not read the yeta pricing: ${error.message}`, "network");
  });

  if (!response.ok) {
    throw new UpstreamError(
      `could not read the yeta pricing (${response.status})`,
      "unavailable",
      response.status,
    );
  }

  const parsed = v.safeParse(PricingSchema, await response.json().catch(() => null));

  if (!parsed.success) throw new UpstreamError("the yeta pricing is not readable", "protocol");

  const prices = new Map<string, ModelPrices>();

  for (const row of parsed.output.data) {
    if (!prices.has(row.model_name)) prices.set(row.model_name, yetaPrices(row));
  }

  return prices;
}

function scaled(factor: number | string | null | undefined, base: number): number | null {
  if (factor === null || factor === undefined) return null;

  const value = Number(factor) * base;

  return Number.isFinite(value) && value >= 0 ? value : null;
}

function numberOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}
