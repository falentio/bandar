import { type FormEvent, useState } from "react";
import { ChevronRightIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  PROVIDER_KINDS,
  type Provider,
  type ProviderKind,
  type ProviderModel,
} from "../../shared/providers";
import { useProviders, type Providers } from "../use-providers";
import { ProviderLogo } from "./provider-logo";

const PLACEHOLDERS: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

const KIND_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI compatible",
  anthropic: "Anthropic compatible",
  google: "Google GenAI compatible",
};

export function ProvidersPanel() {
  const providers = useProviders();
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const selected = providers.providers.find((provider) => provider.id === managing) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Providers</h1>
          <p className="text-sm text-muted-foreground">
            Upstreams your gateway can call. Model aliases are added per provider.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          Add provider
        </Button>
      </div>

      {providers.error === null ? null : (
        <p className="text-sm text-destructive">{providers.error}</p>
      )}

      <Card>
        <CardContent>
          {providers.status === "loading" ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading providers…</p>
          ) : null}

          {providers.status === "ready" && providers.providers.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No providers yet. Add one, then add models to it.
              </p>
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                <PlusIcon data-icon="inline-start" />
                Add provider
              </Button>
            </div>
          ) : null}

          {providers.providers.length === 0 ? null : (
            <ul className="-mx-1 divide-y">
              {providers.providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  onOpen={() => setManaging(provider.id)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateProviderDialog
        open={creating}
        providers={providers}
        onClose={() => setCreating(false)}
      />

      <ManageModelsDialog
        provider={selected}
        providers={providers}
        onClose={() => setManaging(null)}
      />
    </div>
  );
}

function ProviderRow({ provider, onOpen }: { provider: Provider; onOpen: () => void }) {
  const count = provider.models.length;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group/row -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-3 rounded-lg px-2 py-3 text-start transition-colors duration-150 ease-out hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground transition-transform duration-150 ease-out group-hover/row:scale-105">
          <ProviderLogo kind={provider.kind} className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{provider.name}</span>
            {provider.hasKey ? null : (
              <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.7rem] text-destructive">
                no key
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{KIND_LABELS[provider.kind]}</span>
            <span aria-hidden="true">·</span>
            <span>{count === 1 ? "1 model" : `${count} models`}</span>
          </span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-hover/row:translate-x-0.5" />
      </button>
    </li>
  );
}

function CreateProviderDialog({
  open,
  providers,
  onClose,
}: {
  open: boolean;
  providers: Providers;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setBaseUrl("");
    setApiKey("");
    setFormError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const created = await providers.create({
      name: name.trim(),
      kind,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
    });

    if (created) {
      reset();
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>
            Pick the wire the upstream speaks. Models are added after the provider exists.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label>Kind</Label>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Provider kind">
              {PROVIDER_KINDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  onClick={() => {
                    setKind(value);
                    setBaseUrl("");
                  }}
                  disabled={providers.pending}
                  className="group/kind flex flex-col items-center gap-1.5 rounded-lg border bg-background px-2 py-3 text-xs transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-muted/60 active:scale-[0.98] aria-checked:border-foreground/30 aria-checked:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  <ProviderLogo
                    kind={value}
                    className="size-5 transition-transform duration-150 ease-out group-hover/kind:scale-110 group-aria-checked/kind:scale-105"
                  />
                  <span className="font-medium">
                    {KIND_LABELS[value].replace(" compatible", "")}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My OpenAI"
              maxLength={60}
              required
              autoFocus
              disabled={providers.pending}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="provider-base-url">Base URL</Label>
            <Input
              id="provider-base-url"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={PLACEHOLDERS[kind]}
              required
              disabled={providers.pending}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="provider-key">API key</Label>
            <Input
              id="provider-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Optional for local upstreams"
              autoComplete="off"
              disabled={providers.pending}
            />
            <p className="text-xs text-muted-foreground">
              Sealed with AES-GCM before it reaches SQLite. It is never returned by the API.
            </p>
          </div>

          {providers.error === null ? null : (
            <p className="text-sm text-destructive">{providers.error}</p>
          )}
          {formError === null ? null : <p className="text-sm text-destructive">{formError}</p>}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={providers.pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={providers.pending}
              onClick={() => {
                if (name.trim() === "" || baseUrl.trim() === "")
                  setFormError("Name and base URL are required.");
              }}
            >
              {providers.pending ? "Adding…" : "Add provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManageModelsDialog({
  provider,
  providers,
  onClose,
}: {
  provider: Provider | null;
  providers: Providers;
  onClose: () => void;
}) {
  const [upstreamModel, setUpstreamModel] = useState("");
  const [alias, setAlias] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (provider === null) return;

    const added = await providers.addModel(provider.id, {
      upstreamModel: upstreamModel.trim(),
      alias: alias.trim() === "" ? undefined : alias.trim(),
    });

    if (added) {
      setUpstreamModel("");
      setAlias("");
    }
  };

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(next) => {
        if (!next) {
          setUpstreamModel("");
          setAlias("");
          onClose();
        }
      }}
    >
      <DialogContent>
        {provider === null ? null : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                  <ProviderLogo kind={provider.kind} className="size-4" />
                </span>
                <div className="min-w-0">
                  <DialogTitle className="truncate">{provider.name}</DialogTitle>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {provider.baseUrl}
                  </p>
                </div>
              </div>
              <DialogDescription>
                Alias is what clients send as <code>model</code>. Leave it empty to use the upstream
                name.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={submit} className="grid gap-2 rounded-lg border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="upstream-model" className="text-xs">
                    Upstream model
                  </Label>
                  <Input
                    id="upstream-model"
                    value={upstreamModel}
                    onChange={(event) => setUpstreamModel(event.target.value)}
                    placeholder="gpt-4o-mini"
                    maxLength={200}
                    required
                    disabled={providers.pending}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="model-alias" className="text-xs">
                    Alias
                  </Label>
                  <Input
                    id="model-alias"
                    value={alias}
                    onChange={(event) => setAlias(event.target.value)}
                    placeholder="fast"
                    maxLength={100}
                    disabled={providers.pending}
                  />
                </div>
              </div>
              <Button
                type="submit"
                size="sm"
                className="justify-self-start"
                disabled={providers.pending}
              >
                <PlusIcon data-icon="inline-start" />
                Add model
              </Button>
            </form>

            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {provider.models.length === 0
                  ? "No models yet."
                  : `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`}
              </p>
              {provider.models.length === 0 ? null : (
                <ul className="-mx-1 divide-y rounded-lg border">
                  {provider.models.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      pending={providers.pending}
                      onRemove={() => void providers.removeModel(provider.id, model.id)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {providers.error === null ? null : (
              <p className="text-sm text-destructive">{providers.error}</p>
            )}

            <DialogFooter className="items-center sm:justify-between">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={providers.pending}
                onClick={() => {
                  if (window.confirm(`Remove ${provider.name} and all of its models?`)) {
                    void providers.remove(provider.id).then(onClose);
                  }
                }}
              >
                <TrashIcon data-icon="inline-start" />
                Remove provider
              </Button>
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm">
                  Done
                </Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModelRow({
  model,
  pending,
  onRemove,
}: {
  model: ProviderModel;
  pending: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="group/model flex items-center gap-2 px-3 py-2 text-sm">
      <code className="truncate font-medium">{model.alias}</code>
      {model.alias === model.upstreamModel ? null : (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {model.upstreamModel}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${model.alias}`}
        disabled={pending}
        onClick={onRemove}
        className="ms-auto rounded p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,transform] duration-150 ease-out group-hover/model:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-90 disabled:pointer-events-none"
      >
        <TrashIcon className="size-3.5" />
      </button>
    </li>
  );
}
