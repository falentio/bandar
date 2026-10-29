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
  INPUT_MODALITIES,
  parseCompat,
  type Compat,
  type InputModality,
  type ProviderModel,
  type ProviderModelEditInput,
} from "../../shared/providers";
import { MAX_MODEL_SLUG_LENGTH, TAG_REF_PREFIX } from "../../shared/slugs";
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

function parseTokens(text: string): number | null | undefined {
  const trimmed = text.trim();

  if (trimmed === "") return null;

  const value = Number(trimmed);

  return Number.isInteger(value) && value > 0 ? value : undefined;
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
  const [name, setName] = useState(model.alias ?? "");
  const [slug, setSlug] = useState(model.slug);
  const [compat, setCompat] = useState<Compat | null>(model.compat);
  const [inputPrice, setInputPrice] = useState(priceText(model.inputPricePerMtok));
  const [cachePrice, setCachePrice] = useState(priceText(model.cacheInputPricePerMtok));
  const [outputPrice, setOutputPrice] = useState(priceText(model.outputPricePerMtok));
  const [contextWindow, setContextWindow] = useState(priceText(model.contextWindow));
  const [maxOutput, setMaxOutput] = useState(priceText(model.maxOutput));

  const [modalities, setModalities] = useState<readonly InputModality[]>(
    model.inputModalities ?? [],
  );

  const reset = () => {
    setName(model.alias ?? "");
    setSlug(model.slug);
    setCompat(model.compat);
    setInputPrice(priceText(model.inputPricePerMtok));
    setCachePrice(priceText(model.cacheInputPricePerMtok));
    setOutputPrice(priceText(model.outputPricePerMtok));
    setContextWindow(priceText(model.contextWindow));
    setMaxOutput(priceText(model.maxOutput));
    setModalities(model.inputModalities ?? []);
  };

  const parsedInput = parsePrice(inputPrice);
  const parsedCache = parsePrice(cachePrice);
  const parsedOutput = parsePrice(outputPrice);
  const parsedContext = parseTokens(contextWindow);
  const parsedMaxOutput = parseTokens(maxOutput);

  const pricesValid =
    parsedInput !== undefined && parsedCache !== undefined && parsedOutput !== undefined;

  const tokensValid = parsedContext !== undefined && parsedMaxOutput !== undefined;

  const slugValid =
    slug.trim() !== "" &&
    slug.trim().length <= MAX_MODEL_SLUG_LENGTH &&
    !slug.trim().startsWith(TAG_REF_PREFIX);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (
      !pricesValid ||
      !tokensValid ||
      !slugValid ||
      parsedInput === undefined ||
      parsedCache === undefined ||
      parsedOutput === undefined ||
      parsedContext === undefined ||
      parsedMaxOutput === undefined
    ) {
      return;
    }

    const edit: ProviderModelEditInput = {
      slug: slug.trim(),
      alias: name.trim() === "" ? null : name.trim(),
      compat,
      inputPricePerMtok: parsedInput,
      cacheInputPricePerMtok: parsedCache,
      outputPricePerMtok: parsedOutput,
      contextWindow: parsedContext,
      maxOutput: parsedMaxOutput,
      inputModalities: modalities.length === 0 ? null : [...modalities],
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
            The upstream id <code>{model.upstreamModel}</code> stays fixed. The address, name, wire,
            prices, and token limits are yours to set.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="model-edit-alias">Name</Label>
            <Input
              id="model-edit-alias"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={model.upstreamModel}
              maxLength={100}
              autoFocus
              disabled={providers.pending}
            />
            <p className="text-xs text-muted-foreground">
              Shown in the UI only. Clients never send it.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="model-edit-slug">Address</Label>
            <Input
              id="model-edit-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder={model.ref}
              maxLength={MAX_MODEL_SLUG_LENGTH}
              required
              disabled={providers.pending}
              aria-invalid={!slugValid}
            />
            <p className="text-xs text-muted-foreground">
              What clients send as <code>model</code>. It defaults to {model.ref}.
            </p>
            {slugValid ? null : (
              <p className="text-xs text-destructive">
                An address needs at least one character, {MAX_MODEL_SLUG_LENGTH} at most, and cannot
                start with {TAG_REF_PREFIX}.
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

          <div className="grid gap-3 sm:grid-cols-3">
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
              <Label htmlFor="model-edit-cache-price">Cache input price</Label>
              <Input
                id="model-edit-cache-price"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={cachePrice}
                onChange={(event) => setCachePrice(event.target.value)}
                placeholder="unset"
                disabled={providers.pending}
                aria-invalid={parsedCache === undefined}
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

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="model-edit-context-window">Context window</Label>
              <Input
                id="model-edit-context-window"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                placeholder="200000"
                disabled={providers.pending}
                aria-invalid={parsedContext === undefined}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="model-edit-max-output">Max output</Label>
              <Input
                id="model-edit-max-output"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={maxOutput}
                onChange={(event) => setMaxOutput(event.target.value)}
                placeholder="64000"
                disabled={providers.pending}
                aria-invalid={parsedMaxOutput === undefined}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Tokens. Leave a field blank to keep what the provider catalog or models.dev reports.
          </p>
          {tokensValid ? null : (
            <p className="text-xs text-destructive">Token limits are whole numbers above zero.</p>
          )}

          <div className="grid gap-2">
            <span className="text-xs text-muted-foreground">Input modalities</span>
            <div className="flex flex-wrap gap-3">
              {INPUT_MODALITIES.map((modality) => (
                <label key={modality} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={modalities.includes(modality)}
                    onChange={() =>
                      setModalities(
                        modalities.includes(modality)
                          ? modalities.filter((value) => value !== modality)
                          : [...modalities, modality],
                      )
                    }
                    disabled={providers.pending}
                  />
                  {modality}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              What the model accepts as input. Leave every box clear when the provider does not say.
            </p>
          </div>

          {providers.error === null ? null : (
            <p className="text-sm text-destructive">{providers.error}</p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={providers.pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={providers.pending || !pricesValid || !tokensValid || !slugValid}
            >
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
