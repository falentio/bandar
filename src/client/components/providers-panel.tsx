import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROVIDER_KINDS,
  type Provider,
  type ProviderKind,
  type ProviderModelInput,
} from "../../shared/providers";
import { useProviders } from "../use-providers";

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
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModels("");
    setFormError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = modelsOf(models);

    if (parsed.length === 0) {
      setFormError("Add at least one upstream model, one per line.");

      return;
    }

    const created = await providers.create({
      name: name.trim(),
      kind,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      models: parsed,
    });

    if (created) reset();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
          <CardDescription>
            Connect an upstream by kind. The gateway speaks OpenAI to your clients and translates to
            the provider wire. Model aliases are what clients send as <code>model</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="provider-name">Name</Label>
                <Input
                  id="provider-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My OpenAI"
                  maxLength={60}
                  required
                  disabled={providers.pending}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="provider-kind">Kind</Label>
                <select
                  id="provider-kind"
                  value={kind}
                  onChange={(event) => {
                    const next = event.target.value;

                    if (isProviderKind(next)) setKind(next);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  disabled={providers.pending}
                >
                  {PROVIDER_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {KIND_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
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
            <div className="grid gap-2">
              <Label htmlFor="provider-models">Models</Label>
              <textarea
                id="provider-models"
                value={models}
                onChange={(event) => setModels(event.target.value)}
                placeholder={"gpt-4o-mini\nfast=gpt-4o-mini"}
                rows={4}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                disabled={providers.pending}
              />
              <p className="text-xs text-muted-foreground">
                One per line: <code>upstream-model</code> or <code>alias=upstream-model</code>.
                Aliases must be unique across your providers.
              </p>
            </div>

            {formError === null ? null : <p className="text-sm text-destructive">{formError}</p>}
            {providers.error === null ? null : (
              <p className="text-sm text-destructive">{providers.error}</p>
            )}

            <Button type="submit" disabled={providers.pending}>
              {providers.pending ? "Saving…" : "Add provider"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected providers</CardTitle>
          <CardDescription>
            Each alias routes to one upstream model. Remove a provider to remove its models.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {providers.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading providers…</p>
          ) : null}

          {providers.status === "ready" && providers.providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No providers yet.</p>
          ) : null}

          {providers.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              pending={providers.pending}
              onRemove={() => void providers.remove(provider.id)}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ProviderRow({
  provider,
  pending,
  onRemove,
}: {
  provider: Provider;
  pending: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{provider.name}</p>
            <span className="rounded-full border px-2 py-0.5 text-xs">{provider.kind}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {provider.hasKey ? "key saved" : "no key"}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {provider.baseUrl}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Remove ${provider.name} and its models?`)) onRemove();
          }}
        >
          Remove
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {provider.models.map((model) => (
          <code
            key={model.id}
            className="rounded bg-muted px-1.5 py-0.5 text-xs"
            title={model.upstreamModel}
          >
            {model.alias}
          </code>
        ))}
      </div>
    </div>
  );
}

function modelsOf(value: string): ProviderModelInput[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [upstream = "", alias] = line.split("=");

      return {
        upstreamModel: upstream.trim(),
        alias: alias?.trim(),
      };
    });
}

function isProviderKind(value: string): value is ProviderKind {
  return PROVIDER_KINDS.some((kind) => kind === value);
}
