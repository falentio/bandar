import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelChoices } from "../model-options";

type ModelSelectProps = {
  readonly choices: ModelChoices;
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (models: readonly string[]) => void;
};

export function ModelSelect({ choices, selected, disabled, onChange }: ModelSelectProps) {
  const id = useId();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Model ref
      </label>
      <Select
        value={selected[0] ?? ""}
        onValueChange={(value) => onChange([value])}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          {choices.tags.length === 0 ? null : (
            <SelectGroup>
              <SelectLabel>Tags</SelectLabel>
              {choices.tags.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {choices.providers.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
