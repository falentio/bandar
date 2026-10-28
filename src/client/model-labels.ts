import { modelLabelOf, type Provider } from "../shared/providers";

export type ModelLabels = {
  readonly bySlug: ReadonlyMap<string, string>;
  readonly byId: ReadonlyMap<string, string>;
};

/** Names for every model the account can route to. The address stays the fallback. */
export function modelLabels(providers: readonly Provider[]): ModelLabels {
  const bySlug = new Map<string, string>();
  const byId = new Map<string, string>();

  for (const provider of providers) {
    for (const model of provider.models) {
      const label = modelLabelOf(model);

      bySlug.set(model.slug, label);
      byId.set(model.id, label);
    }
  }

  return { bySlug, byId };
}

export function labelForSlug(labels: ModelLabels, slug: string): string {
  return labels.bySlug.get(slug) ?? slug;
}

export function labelForId(labels: ModelLabels, modelId: string, fallback: string): string {
  return labels.byId.get(modelId) ?? fallback;
}
