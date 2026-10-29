import { useId, useState } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ModelChoiceGroup, ModelChoices, ModelOption } from "../model-options";

const SEARCH_THRESHOLD = 8;

export const CONTROL_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";

type ModelControlProps = {
  readonly choices: ModelChoices;
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (models: readonly string[]) => void;
};

export function ModelPicker({ choices, selected, disabled, onChange }: ModelControlProps) {
  const headingId = useId();
  const [query, setQuery] = useState("");
  const groups = groupedChoices(choices);
  const rows = visibleGroups(groups, query);
  const total = groups.flatMap((group) => group.options).length;
  const label = triggerLabel(selected);

  const toggle = (value: string): void => {
    onChange(
      selected.includes(value)
        ? selected.filter((candidate) => candidate !== value)
        : [...selected, value],
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <span id={headingId} className="text-xs text-muted-foreground">
        Models
      </span>
      <div className="flex flex-col gap-1.5">
        <Popover
          onOpenChange={(open) => {
            if (!open) setQuery("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-labelledby={headingId}
              className={`flex items-center gap-2 ${CONTROL_CLASS}`}
            >
              <span
                className={selected.length === 0 ? "truncate text-muted-foreground" : "truncate"}
              >
                {label}
              </span>
              <ChevronDownIcon className="ms-auto size-3.5 shrink-0 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-(--radix-popover-trigger-width) space-y-2 p-2">
            {total > SEARCH_THRESHOLD ? (
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                aria-label="Search models"
                className="h-7"
              />
            ) : null}
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {rows.length === 0 ? (
                <p className="px-1.5 py-2 text-xs text-muted-foreground">
                  {total === 0 ? "No models yet" : "No matches"}
                </p>
              ) : null}
              {rows.map((group) => (
                <div key={group.label} className="space-y-0.5">
                  <p className="px-1.5 pt-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                  {group.options.map((option) => (
                    <label
                      key={option.value}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors duration-150 ease-out hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 shrink-0 accent-primary"
                        checked={selected.includes(option.value)}
                        onChange={() => toggle(option.value)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={option.value}>
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {selected.length === 0 ? null : (
          <ol className="flex flex-wrap gap-1">
            {selected.map((ref, index) => (
              <li
                key={ref}
                className="flex min-w-0 items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-2 pe-1"
              >
                <span className="truncate font-mono text-xs" title={ref}>
                  {ref}
                </span>
                {index === 0 ? (
                  <span className="shrink-0 text-[0.65rem] text-muted-foreground uppercase">
                    default
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${ref}`}
                  onClick={() => onChange(selected.filter((candidate) => candidate !== ref))}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function ModelSelect({ choices, selected, disabled, onChange }: ModelControlProps) {
  const id = useId();
  const value = selected[0] ?? "";

  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Model ref</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value === "" ? [] : [event.target.value])}
        disabled={disabled}
        className={CONTROL_CLASS}
      >
        <option value="">Select a model</option>
        {choices.tags.length === 0 ? null : (
          <optgroup label="Tags">
            {choices.tags.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
        {choices.providers.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function groupedChoices(choices: ModelChoices): readonly ModelChoiceGroup[] {
  if (choices.tags.length === 0) return choices.providers;

  return [{ label: "Tags", options: choices.tags }, ...choices.providers];
}

function visibleGroups(
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

function matchesQuery(option: ModelOption, needle: string): boolean {
  if (needle === "") return true;

  return option.value.toLowerCase().includes(needle) || option.label.toLowerCase().includes(needle);
}

function triggerLabel(selected: readonly string[]): string {
  const [first, ...rest] = selected;

  if (first === undefined) return "Select models";

  if (rest.length === 0) return first;

  return `${String(selected.length)} models`;
}
