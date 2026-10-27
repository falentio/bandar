import { type FormEvent, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
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
import { PROVIDER_KINDS, type Provider, type ProviderKind } from "../../shared/providers";
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
                <ProviderRow key={provider.id} provider={provider} />
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
    </div>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const count = provider.models.length;

  return (
    <li>
      <Link
        to="/providers/$providerId"
        params={{ providerId: provider.id }}
        search={{ tab: "overview" }}
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
      </Link>
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
