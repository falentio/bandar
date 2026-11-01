import { useEffect, useId, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  type ModelChoiceGroup,
  type ModelOption,
  optionId,
  step,
  visibleGroups,
} from "../model-options";
import {
  appendModel,
  availableGroups,
  modelIdsOf,
  moveModelTo,
  type RankedModel,
  removeModel,
} from "../ranked-models";

type RankedModelPickerProps = {
  readonly catalog: readonly ModelChoiceGroup[];
  readonly value: readonly RankedModel[];
  readonly onChange: (modelIds: readonly string[]) => void;
  readonly disabled: boolean;
};

type Row = { readonly option: ModelOption; readonly provider: string };

export function RankedModelPicker({ catalog, value, onChange, disabled }: RankedModelPickerProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const groups = visibleGroups(availableGroups(catalog, value), query);

  const rows: readonly Row[] = groups.flatMap((group) =>
    group.options.map((option) => ({ option, provider: group.label })),
  );

  const options = rows.map((row) => row.option);

  const highlighted = options.some((option) => option.value === active)
    ? active
    : (options[0]?.value ?? null);

  const listboxId = `${id}-listbox`;
  const only = value.length === 1;

  useEffect(() => {
    if (disabled || !refocus.current) return;

    refocus.current = false;
    input.current?.focus();
    setOpen(true);
  }, [disabled]);

  const commit = (next: readonly RankedModel[]): void => {
    if (next === value) return;

    onChange(modelIdsOf(next));
  };

  const append = (row: Row): void => {
    setQuery("");
    setActive(null);
    setOpen(true);
    refocus.current = true;
    commit(
      appendModel(value, {
        modelId: row.option.value,
        label: row.option.label,
        provider: row.provider,
      }),
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
      const row = rows.find((candidate) => candidate.option.value === highlighted);

      if (!open || row === undefined) return;

      event.preventDefault();
      append(row);

      return;
    }

    if (event.key === "Escape") {
      if (!open) return;

      event.preventDefault();
      setOpen(false);
      setQuery("");

      return;
    }

    if (event.key === "Backspace" && query === "") {
      const tail = value[value.length - 1];

      if (tail === undefined) return;

      event.preventDefault();
      commit(removeModel(value, tail.modelId));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Models, in fallback order
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Input
            ref={input}
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
            placeholder={value.length === 0 ? "Add the first model" : "Search models"}
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
          <div id={listboxId} role="listbox">
            {rows.length === 0 ? (
              <p className="px-1.5 py-2 text-xs text-muted-foreground">
                {query === "" ? "No models left to add" : "No matches"}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <p className="px-1.5 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
                {group.options.map((option) => (
                  <div
                    key={option.value}
                    id={optionId(id, option.value)}
                    role="option"
                    aria-selected={option.value === highlighted}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(option.value)}
                    onClick={() => append({ option, provider: group.label })}
                    className={`flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm ${
                      option.value === highlighted ? "bg-accent text-accent-foreground" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {value.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1">
          {value.map((model, index) => (
            <li
              key={model.modelId}
              className="flex min-w-0 items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-1 pe-1"
            >
              {only ? (
                <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
                  #{index + 1}
                </span>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={disabled}
                      aria-label={`Move ${model.label} to another position`}
                      className="px-1 text-xs tabular-nums text-muted-foreground"
                    >
                      #{index + 1}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>Tried in this order</DropdownMenuLabel>
                    {value.map((target, position) => (
                      <DropdownMenuItem
                        key={target.modelId}
                        disabled={position === index}
                        onSelect={() => commit(moveModelTo(value, model.modelId, position))}
                      >
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          #{position + 1}
                        </span>
                        <span className="truncate">{target.label}</span>
                        {position === index ? (
                          <span className="ms-auto text-xs text-muted-foreground">current</span>
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <span className="min-w-0 truncate text-xs" title={model.label}>
                {model.label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{model.provider}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${model.label} from the chain`}
                title={
                  only
                    ? "A tag keeps at least one model. Delete the tag to remove its last model."
                    : undefined
                }
                disabled={disabled || only}
                onClick={() => commit(removeModel(value, model.modelId))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">The first model you add is #1.</p>
      ) : null}
      {only ? (
        <p className="text-xs text-muted-foreground">A tag keeps at least one model.</p>
      ) : null}
    </div>
  );
}
