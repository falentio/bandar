import { modelLabelOf } from "./model-labels";

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

export function optionId(comboboxId: string, value: string): string {
  return `${comboboxId}-${encodeURIComponent(value)}`;
}

export function step(
  options: readonly ModelOption[],
  highlighted: string | null,
  delta: number,
): string | null {
  if (options.length === 0) return null;

  const current = options.findIndex((option) => option.value === highlighted);
  const next = (current + delta + options.length) % options.length;

  return options[next]?.value ?? null;
}

export function visibleGroups(
  groups: readonly ModelChoiceGroup[],
  query: string,
): readonly ModelChoiceGroup[] {
  const needle = query.trim().toLowerCase();
  const rows: ModelChoiceGroup[] = [];

  for (const group of groups) {
    const options = group.options.filter((option) => matchesQuery(option, needle));

    if (options.length > 0) rows.push({ label: group.label, options });
  }

  return rows;
}

export function matchesQuery(option: ModelOption, needle: string): boolean {
  return option.value.toLowerCase().includes(needle) || option.label.toLowerCase().includes(needle);
}
