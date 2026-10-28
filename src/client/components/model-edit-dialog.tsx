import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COMPAT_LABELS,
  parseCompat,
  type Compat,
  type ProviderModel,
  type ProviderModelEditInput,
} from "../../shared/providers";
import type { Providers } from "../use-providers";

// An unset field means the catalog's price stands, so the input round-trips to null.
function parsePrice(text: string): number | null | undefined {
  const trimmed = text.trim();

  if (trimmed === "") return null;

  const value = Number(trimmed);

  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function priceText(value: number | null): string {
  return value === null ? "" : String(value);
}

export function EditModelDialog({
  providerId,
  model,
  compats,
  providers,
  onSaved,
  open,
  onOpenChange,
}: {
  providerId: string;
  model: ProviderModel;
  compats: readonly Compat[];
  providers: Providers;
  onSaved: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [alias, setAlias] = useState(model.alias);
  const [compat, setCompat] = useState<Compat | null>(model.compat);
  const [inputPrice, setInputPrice] = useState(priceText(model.inputPricePerMtok));
  const [outputPrice, setOutputPrice] = useState(priceText(model.outputPricePerMtok));

  const reset = () => {
    setAlias(model.alias);
    setCompat(model.compat);
    setInputPrice(priceText(model.inputPricePerMtok));
    setOutputPrice(priceText(model.outputPricePerMtok));
  };

  const parsedInput = parsePrice(inputPrice);
  const parsedOutput = parsePrice(outputPrice);
  const pricesValid = parsedInput !== undefined && parsedOutput !== undefined;
  const aliasValid = alias.trim() !== "" && !alias.trim().startsWith("tags/");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!pricesValid || !aliasValid || parsedInput === undefined || parsedOutput === undefined) {
      return;
    }

    const edit: ProviderModelEditInput = {
      alias: alias.trim(),
      compat,
      inputPricePerMtok: parsedInput,
      outputPricePerMtok: parsedOutput,
    };

    if (await providers.updateModel(providerId, model.id, edit)) {
      onSaved();
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit model</DialogTitle>
          <DialogDescription>
            The upstream id stays fixed. The name, wire, and prices are yours to set.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="model-edit-alias">Name</Label>
            <Input
              id="model-edit-alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder={model.upstreamModel}
              maxLength={100}
              autoFocus
              disabled={providers.pending}
              aria-invalid={!aliasValid}
            />
            <p className="text-xs text-muted-foreground">
              What clients send. The label matches the upstream id unless you change it.
            </p>
            {aliasValid ? null : (
              <p className="text-xs text-destructive">
                A name needs at least one character and cannot start with tags/.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="model-edit-compat">Protocol</Label>
            <select
              id="model-edit-compat"
              value={compat ?? ""}
              onChange={(event) => setCompat(parseCompat(event.target.value))}
              disabled={providers.pending}
              className="h-8 w-full rounded-lg border bg-background px-2 text-sm transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <option value="">{compatLabel(model)}</option>
              {compat === null || compats.includes(compat) ? null : (
                <option value={compat}>{COMPAT_LABELS[compat]} (unavailable)</option>
              )}
              {compats.map((value) => (
                <option key={value} value={value}>
                  {COMPAT_LABELS[value]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              The wire this model answers on. Leave it on the provider default unless the upstream
              only speaks one.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="model-edit-input-price">Input price</Label>
              <Input
                id="model-edit-input-price"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
                placeholder="unset"
                disabled={providers.pending}
                aria-invalid={parsedInput === undefined}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="model-edit-output-price">Output price</Label>
              <Input
                id="model-edit-output-price"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
                placeholder="unset"
                disabled={providers.pending}
                aria-invalid={parsedOutput === undefined}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            US dollars per million tokens. Leave a field blank to keep it unpriced.
          </p>
          {pricesValid ? null : (
            <p className="text-xs text-destructive">Prices are zero or a positive number.</p>
          )}

          {providers.error === null ? null : (
            <p className="text-sm text-destructive">{providers.error}</p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={providers.pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={providers.pending || !pricesValid || !aliasValid}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function compatLabel(model: ProviderModel): string {
  if (model.defaultCompat === null) return "Provider default (no wire)";

  return `Provider default (${COMPAT_LABELS[model.defaultCompat]})`;
}
