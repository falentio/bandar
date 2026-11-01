import type { Tag } from "../shared/tags";
import { optionLabelWithSlug } from "./model-labels";
import type { ModelChoiceGroup } from "./model-options";

type TagModel = Tag["models"][number];

/** One row of a tag's chain. The index is the fallback priority, so the order is the state. */
export type RankedModel = {
  readonly modelId: string;
  readonly label: string;
  readonly provider: string;
};

export function rankedModels(models: readonly TagModel[]): readonly RankedModel[] {
  return models.map((model) => ({
    modelId: model.modelId,
    label: optionLabelWithSlug(model),
    provider: model.providerName,
  }));
}

export function modelIdsOf(ranked: readonly RankedModel[]): readonly string[] {
  return ranked.map((model) => model.modelId);
}

export function appendModel(
  ranked: readonly RankedModel[],
  model: RankedModel,
): readonly RankedModel[] {
  if (ranked.some((row) => row.modelId === model.modelId)) return ranked;

  return [...ranked, model];
}

export function removeModel(
  ranked: readonly RankedModel[],
  modelId: string,
): readonly RankedModel[] {
  if (ranked.length === 1) return ranked;

  return ranked.some((row) => row.modelId === modelId)
    ? ranked.filter((row) => row.modelId !== modelId)
    : ranked;
}

export function moveModelTo(
  ranked: readonly RankedModel[],
  modelId: string,
  position: number,
): readonly RankedModel[] {
  const from = ranked.findIndex((row) => row.modelId === modelId);

  if (from === -1) return ranked;

  const to = Math.min(Math.max(position, 0), ranked.length - 1);
  const moved = ranked[from];

  if (to === from || moved === undefined) return ranked;

  const next = ranked.filter((row) => row.modelId !== modelId);

  next.splice(to, 0, moved);

  return next;
}

export function availableGroups(
  catalog: readonly ModelChoiceGroup[],
  ranked: readonly RankedModel[],
): readonly ModelChoiceGroup[] {
  const picked = new Set(modelIdsOf(ranked));
  const groups: ModelChoiceGroup[] = [];

  for (const group of catalog) {
    const options = group.options.filter((option) => !picked.has(option.value));

    if (options.length > 0) groups.push({ label: group.label, options });
  }

  return groups;
}
