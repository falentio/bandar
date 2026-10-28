import type { Provider } from "../shared/providers";

export function modelLabelOf(model: {
  readonly alias: string | null;
  readonly upstreamModel: string;
}): string {
  return model.alias ?? model.upstreamModel;
}

export type ModelLabels = {
  readonly bySlug: ReadonlyMap<string, string>;
  readonly byId: ReadonlyMap<string, string>;
};

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
