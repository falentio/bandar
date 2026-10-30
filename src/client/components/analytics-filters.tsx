import { type ReactNode, useState } from "react";
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
import { githubRepoOf } from "../../shared/project";
import { PROVIDER_KIND_LABELS, PROVIDER_KINDS, type Provider } from "../../shared/providers";
import type { Tag } from "../../shared/tags";
import { modelLabelOf } from "../model-labels";
import { useAnalyticsValues } from "../use-analytics-values";
import { useProviders } from "../use-providers";
import { useTags } from "../use-tags";
import { GithubLogo } from "./github-logo";

const SEARCH_THRESHOLD = 8;

type FilterOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly title?: string;
};

type TriggerLabel = {
  readonly text: string;
  readonly title: string;
  readonly icon: ReactNode;
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
  const projects = useAnalyticsValues("projectUrl");
  const sessions = useAnalyticsValues("sessionId");
  const error = providers.error ?? tags.error ?? projects.error ?? sessions.error;

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
        options={projectOptions(projects.values)}
        selected={filters.projectUrl}
        onChange={(values) => update("projectUrl", values)}
        onOpen={projects.refresh}
        emptyLabel="No projects yet"
      />
      <FilterMenu
        label="Session"
        options={valueOptions(sessions.values)}
        selected={filters.sessionId}
        onChange={(values) => update("sessionId", values)}
        onOpen={sessions.refresh}
        emptyLabel="No sessions yet"
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
          {label.icon}
          <span className="max-w-48 truncate" title={label.title}>
            {label.text}
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
              {row.icon === undefined ? null : <span className="shrink-0">{row.icon}</span>}
              <span className="min-w-0 flex-1 truncate" title={row.title ?? row.value}>
                {row.label}
              </span>
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

function valueOptions(values: readonly string[]): readonly FilterOption[] {
  return values.map((value) => ({ value, label: value }));
}

function projectOptions(values: readonly string[]): readonly FilterOption[] {
  return values.map((url) => {
    const repo = githubRepoOf(url);

    if (repo === null) return { value: url, label: withoutScheme(url), title: url };

    return {
      value: url,
      label: `${repo.owner}/${repo.repo}`,
      title: url,
      icon: <GithubLogo />,
    };
  });
}

function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function triggerLabel(
  label: string,
  options: readonly FilterOption[],
  selected: readonly string[],
): TriggerLabel {
  if (selected.length === 0) return { text: label, title: label, icon: null };

  if (selected.length > 1) {
    const text = `${label} (${String(selected.length)})`;

    return { text, title: text, icon: null };
  }

  const [value] = selected;

  if (value === undefined) return { text: label, title: label, icon: null };

  for (const option of options) {
    if (option.value === value) {
      const text = `${label}: ${option.label}`;

      return { text, title: option.title ?? text, icon: option.icon ?? null };
    }
  }

  const text = `${label}: ${value}`;

  return { text, title: text, icon: null };
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
