import * as v from "valibot";
import { AnalyticsFiltersSchema, type AnalyticsFilterDimension } from "../shared/analytics";
import { ProviderKindSchema } from "../shared/providers";

export const AnalyticsFiltersInputSchema = v.object({
  ...AnalyticsFiltersSchema.entries,
  providerKind: v.pipe(v.array(ProviderKindSchema), v.maxLength(50)),
});

export function filterParams(search: URLSearchParams): Record<AnalyticsFilterDimension, string[]> {
  return {
    providerKind: nonBlankValues(search, "providerKind"),
    providerId: nonBlankValues(search, "providerId"),
    model: nonBlankValues(search, "model"),
    tag: nonBlankValues(search, "tag"),
    projectUrl: nonBlankValues(search, "projectUrl"),
    sessionId: nonBlankValues(search, "sessionId"),
  };
}

export function nonBlankValues(
  search: URLSearchParams,
  dimension: AnalyticsFilterDimension,
): string[] {
  return search.getAll(dimension).filter((value) => !isBlank(value));
}

export function isBlank(value: string): boolean {
  return value.trim() === "";
}
