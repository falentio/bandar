import { useId, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { ModelChoiceGroup, ModelChoices, ModelOption } from "../model-options";

type ModelComboboxProps = {
  readonly choices: ModelChoices;
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (models: readonly string[]) => void;
};

export function ModelCombobox({ choices, selected, disabled, onChange }: ModelComboboxProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const groups = visibleGroups(groupedChoices(choices), query);
  const options = groups.flatMap((group) => group.options);

  const highlighted = options.some((option) => option.value === active)
    ? active
    : (options[0]?.value ?? null);

  const listboxId = `${id}-listbox`;

  const choose = (value: string): void => {
    setQuery("");
    setActive(value);
    setOpen(true);
    onChange(
      selected.includes(value) ? selected.filter((ref) => ref !== value) : [...selected, value],
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive(step(options, highlighted, event.key === "ArrowDown" ? 1 : -1));

      return;
    }

    if (event.key === "Enter") {
      if (!open || highlighted === null) return;

      event.preventDefault();
      choose(highlighted);

      return;
    }

    if (event.key === "Escape") {
      if (!open) return;

      event.preventDefault();
      setOpen(false);
      setQuery("");

      return;
    }

    if (event.key === "Backspace" && query === "" && selected.length > 0) {
      event.preventDefault();
      onChange(selected.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Models
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Input
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && highlighted !== null ? optionId(id, highlighted) : undefined
            }
            autoComplete="off"
            spellCheck={false}
            value={query}
            disabled={disabled}
            placeholder="Search models"
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="max-h-64 w-(--radix-popover-trigger-width) overflow-y-auto p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div id={listboxId} role="listbox" aria-multiselectable>
            {options.length === 0 ? (
              <p className="px-1.5 py-2 text-xs text-muted-foreground">
                {query === "" ? "No models yet" : "No matches"}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <p className="px-1.5 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
                {group.options.map((option) => {
                  const picked = selected.includes(option.value);

                  return (
                    <div
                      key={option.value}
                      id={optionId(id, option.value)}
                      role="option"
                      aria-selected={picked}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActive(option.value)}
                      onClick={() => choose(option.value)}
                      className={`flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm ${
                        option.value === highlighted ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate" title={option.value}>
                        {option.label}
                      </span>
                      {picked ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                    </div>
                  );
                })}
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
  );
}

function optionId(comboboxId: string, value: string): string {
  return `${comboboxId}-${value.replace(/[^a-zA-Z0-9]+/gu, "-")}`;
}

function step(
  options: readonly ModelOption[],
  highlighted: string | null,
  delta: number,
): string | null {
  if (options.length === 0) return null;

  const current = options.findIndex((option) => option.value === highlighted);
  const next = (current + delta + options.length) % options.length;

  return options[next]?.value ?? null;
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
