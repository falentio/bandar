import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  EMPTY_ANALYTICS_FILTERS,
  hasAnalyticsFilters,
  type AnalyticsFilterDimension,
  type AnalyticsFilters,
} from "../../shared/analytics";
import { PROVIDER_KIND_LABELS, PROVIDER_KINDS, type Provider } from "../../shared/providers";
import type { Tag } from "../../shared/tags";
import { modelLabelOf } from "../model-labels";
import { useProjects } from "../use-projects";
import { useProviders } from "../use-providers";
import { useTags } from "../use-tags";

const SEARCH_THRESHOLD = 8;

type FilterOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
};

type AnalyticsFilterBarProps = {
  readonly filters: AnalyticsFilters;
  readonly onChange: (filters: AnalyticsFilters) => void;
};

type FilterMenuProps = {
  readonly label: string;
  readonly options: readonly FilterOption[];
  readonly selected: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  readonly onOpen?: () => void;
  readonly emptyLabel?: string;
};

export function AnalyticsFilterBar({ filters, onChange }: AnalyticsFilterBarProps) {
  const providers = useProviders();
  const tags = useTags();
  const projects = useProjects();
  const error = providers.error ?? tags.error ?? projects.error;

  const update = (dimension: AnalyticsFilterDimension, values: readonly string[]): void => {
    onChange({ ...filters, [dimension]: [...values] });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterMenu
        label="Provider"
        options={providerKindOptions()}
        selected={filters.providerKind}
        onChange={(values) => update("providerKind", values)}
      />
      <FilterMenu
        label="Account"
        options={providerAccountOptions(providers.providers)}
        selected={filters.providerId}
        onChange={(values) => update("providerId", values)}
      />
      <FilterMenu
        label="Model"
        options={modelOptions(providers.providers)}
        selected={filters.model}
        onChange={(values) => update("model", values)}
      />
      <FilterMenu
        label="Tag"
        options={tagOptions(tags.tags)}
        selected={filters.tag}
        onChange={(values) => update("tag", values)}
      />
      <FilterMenu
        label="Project"
        options={projectOptions(projects.projects)}
        selected={filters.projectUrl}
        onChange={(values) => update("projectUrl", values)}
        onOpen={projects.refresh}
        emptyLabel="No projects yet"
      />
      {hasAnalyticsFilters(filters) ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_ANALYTICS_FILTERS)}>
          Clear
        </Button>
      ) : null}
      {error === null ? null : <p className="text-xs text-muted-foreground">{error}</p>}
    </div>
  );
}

function FilterMenu({
  label: name,
  options,
  selected,
  onChange,
  onOpen,
  emptyLabel,
}: FilterMenuProps) {
  const [query, setQuery] = useState("");
  const rows = visibleOptions(options, selected, query);
  const label = triggerLabel(name, options, selected);

  const toggle = (value: string): void => {
    onChange(
      selected.includes(value)
        ? selected.filter((candidate) => candidate !== value)
        : [...selected, value],
    );
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) onOpen?.();
        else setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={selected.length === 0 ? "outline" : "default"} size="sm">
          <span className="max-w-48 truncate" title={label}>
            {label}
          </span>
          <ChevronDownIcon data-icon="inline-end" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-2">
        {options.length > SEARCH_THRESHOLD ? (
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${name.toLowerCase()}s`}
            aria-label={`Search ${name.toLowerCase()}`}
            className="h-7"
          />
        ) : null}
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              {query === "" && emptyLabel !== undefined ? emptyLabel : "No matches"}
            </p>
          ) : null}
          {rows.map((row) => (
            <label
              key={row.value}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                className="size-3.5 shrink-0 accent-primary"
                checked={selected.includes(row.value)}
                onChange={() => toggle(row.value)}
              />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.hint === undefined ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">{row.hint}</span>
              )}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function providerKindOptions(): readonly FilterOption[] {
  return PROVIDER_KINDS.map((kind) => ({ value: kind, label: PROVIDER_KIND_LABELS[kind] }));
}

function providerAccountOptions(providers: readonly Provider[]): readonly FilterOption[] {
  const options: FilterOption[] = [];

  for (const provider of providers) {
    options.push({
      value: provider.id,
      label: provider.name,
      hint: PROVIDER_KIND_LABELS[provider.kind],
    });
  }

  return options;
}

function modelOptions(providers: readonly Provider[]): readonly FilterOption[] {
  const options: FilterOption[] = [];

  for (const provider of providers) {
    for (const model of provider.models) {
      options.push({ value: model.slug, label: modelLabelOf(model), hint: provider.name });
    }
  }

  return options;
}

function tagOptions(tags: readonly Tag[]): readonly FilterOption[] {
  return tags.map((tag) => ({ value: tag.slug, label: tag.ref }));
}

function projectOptions(projects: readonly string[]): readonly FilterOption[] {
  return projects.map((url) => ({ value: url, label: url }));
}

function triggerLabel(
  label: string,
  options: readonly FilterOption[],
  selected: readonly string[],
): string {
  if (selected.length === 0) return label;

  if (selected.length > 1) return `${label} (${String(selected.length)})`;

  const [value] = selected;

  if (value === undefined) return label;

  for (const option of options) {
    if (option.value === value) return `${label}: ${option.label}`;
  }

  return `${label}: ${value}`;
}

function visibleOptions(
  options: readonly FilterOption[],
  selected: readonly string[],
  query: string,
): readonly FilterOption[] {
  const needle = query.trim().toLowerCase();
  const known = new Set<string>();
  const rows: FilterOption[] = [];

  for (const option of options) {
    known.add(option.value);

    if (matchesQuery(option, needle)) rows.push(option);
  }

  for (const value of selected) {
    if (known.has(value)) continue;

    const row: FilterOption = { value, label: value };

    if (matchesQuery(row, needle)) rows.push(row);
  }

  return rows;
}

function matchesQuery(option: FilterOption, needle: string): boolean {
  if (needle === "") return true;

  if (option.label.toLowerCase().includes(needle)) return true;

  return option.hint !== undefined && option.hint.toLowerCase().includes(needle);
}
