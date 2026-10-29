import * as v from "valibot";
import { AnalyticsFiltersSchema, type AnalyticsFilterDimension } from "../shared/analytics";
import { ProviderKindSchema } from "../shared/providers";

export const AnalyticsFiltersInputSchema = v.object({
  ...AnalyticsFiltersSchema.entries,
  providerKind: v.pipe(v.array(ProviderKindSchema), v.maxLength(50)),
});

export function filterParams(search: URLSearchParams): Record<AnalyticsFilterDimension, string[]> {
  return {
    providerKind: search.getAll("providerKind"),
    providerId: search.getAll("providerId"),
    model: search.getAll("model"),
    tag: search.getAll("tag"),
    projectUrl: search.getAll("projectUrl"),
  };
}
