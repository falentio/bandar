import { modelLabelOf } from "../shared/providers";

export type ModelOption = { readonly value: string; readonly label: string };

export type ModelChoiceGroup = {
  readonly label: string;
  readonly options: readonly ModelOption[];
};

export type ModelChoices = {
  readonly tags: readonly ModelOption[];
  readonly providers: readonly ModelChoiceGroup[];
};

type ProviderSource = {
  readonly name: string;
  readonly models: readonly {
    readonly slug: string;
    readonly alias: string | null;
    readonly upstreamModel: string;
  }[];
};

type TagSource = { readonly ref: string };

export function modelChoices(
  providers: readonly ProviderSource[],
  tags: readonly TagSource[],
): ModelChoices {
  const taken = new Set<string>();
  const tagOptions: ModelOption[] = [];

  for (const tag of tags) {
    if (taken.has(tag.ref)) continue;

    taken.add(tag.ref);
    tagOptions.push({ value: tag.ref, label: tag.ref });
  }

  const groups: ModelChoiceGroup[] = [];

  for (const provider of providers) {
    const options: ModelOption[] = [];

    for (const model of provider.models) {
      if (taken.has(model.slug)) continue;

      taken.add(model.slug);

      const label = modelLabelOf(model);

      options.push({
        value: model.slug,
        label: label === model.slug ? label : `${label} (${model.slug})`,
      });
    }

    if (options.length === 0) continue;

    groups.push({ label: provider.name, options });
  }

  return { tags: tagOptions, providers: groups };
}
