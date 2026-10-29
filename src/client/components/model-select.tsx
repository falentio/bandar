import { useId } from "react";
import type { ModelChoices } from "../model-options";

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";

type ModelSelectProps = {
  readonly choices: ModelChoices;
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (models: readonly string[]) => void;
};

export function ModelSelect({ choices, selected, disabled, onChange }: ModelSelectProps) {
  const id = useId();

  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Model ref</span>
      <select
        id={id}
        value={selected[0] ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? [] : [event.target.value])}
        disabled={disabled}
        className={SELECT_CLASS}
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
