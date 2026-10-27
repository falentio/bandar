import { type FormEvent, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProviderUsage } from "../../shared/analytics";
import {
  PROVIDER_KINDS,
  type Provider,
  type ProviderKind,
  type ProviderModel,
} from "../../shared/providers";
import {
  formatExactTokens,
  formatMs,
  formatPercent,
  formatTokens,
  formatTps,
  formatUsd,
  formatWhen,
} from "../format";
import { providerApi } from "../api";
import { describeError, isError } from "../errors";
import { useProviderDetail } from "../use-provider-detail";
import { useProviders } from "../use-providers";
import { useRequests } from "../use-requests";
import { ProviderLogo } from "./provider-logo";

const RANGES = [7, 30, 90] as const;

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

export function ProviderPage({ providerId }: { providerId: string }) {
  const providers = useProviders();
  const detail = useProviderDetail(providerId);

  const provider = detail.detail?.provider ?? null;

  return (
    <div className="space-y-4">
      <Link
        to="/providers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All providers
      </Link>

      {provider === null ? (
        detail.status === "error" ? (
          <Card>
            <CardHeader>
              <CardTitle>Provider not available</CardTitle>
              <CardDescription>
                {detail.error ?? "It may have been removed from another session."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link to="/providers">Back to providers</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="flex items-center gap-3">
            <Skeleton className="size-11 rounded-xl" />
            <div className="grid gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted">
                <ProviderLogo kind={provider.kind} className="size-5" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold">{provider.name}</h1>
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                  <span>{KIND_LABELS[provider.kind]}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate font-mono text-xs">{provider.baseUrl}</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {RANGES.map((days) => (
                <Button
                  key={days}
                  variant={detail.days === days ? "default" : "outline"}
                  size="sm"
                  onClick={() => detail.setDays(days)}
                >
                  {days}d
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={detail.refresh}>
                Refresh
              </Button>
            </div>
          </div>

          <UsageSection usage={detail.detail?.usage ?? null} />

          <SettingsCard
            provider={provider}
            onSaved={(updated) => {
              providers.apply(updated);
              detail.refresh();
            }}
          />

          <ModelsCard provider={provider} providers={providers} onChanged={detail.refresh} />

          <RequestsCard providerId={provider.id} providerName={provider.name} />
        </>
      )}
    </div>
  );
}

function UsageSection({ usage }: { usage: ProviderUsage | null }) {
  if (usage === null) return <Skeleton className="h-24 w-full rounded-xl" />;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Requests"
          value={formatTokens(usage.requests)}
          hint={`last ${usage.days} days`}
        />
        <Stat
          label="Tokens"
          value={formatTokens(usage.totalTokens)}
          hint={`${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`}
        />
        <Stat
          label="Error rate"
          value={formatPercent(usage.errorRate)}
          hint={`${usage.errors} failed`}
        />
        <Stat label="Cost" value={formatUsd(usage.costUsd)} hint="priced models only" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Avg / day" value={formatTokens(usage.avgTokensPerDay)} />
        <Stat label="Avg speed" value={formatTps(usage.avgTps)} hint="generation only" />
        <Stat label="Avg TTFT" value={formatMs(usage.avgTtftMs)} hint="first token" />
        <Stat
          label="Last request"
          value={usage.lastRequestAt === null ? "—" : formatWhen(usage.lastRequestAt)}
          hint="in this window"
        />
      </div>
    </>
  );
}

function SettingsCard({
  provider,
  onSaved,
}: {
  provider: Provider;
  onSaved: (provider: Provider) => void;
}) {
  const settings = useProviderSettings(provider);
  const [saved, setSaved] = useState(false);

  const dirty =
    settings.name.trim() !== provider.name ||
    settings.kind !== provider.kind ||
    settings.baseUrl.trim() !== provider.baseUrl ||
    settings.apiKey.trim() !== "";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);

    const result = await settings.save();

    if (result === null) return;

    setSaved(true);
    onSaved(result);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          Changing the kind or base URL affects every model on this provider.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label>Kind</Label>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Provider kind">
              {PROVIDER_KINDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={settings.kind === value}
                  onClick={() => settings.setKind(value)}
                  className="group/kind flex flex-col items-center gap-1.5 rounded-lg border bg-background px-2 py-3 text-xs transition-[background-color,border-color] duration-150 ease-out hover:bg-muted/60 active:scale-[0.98] aria-checked:border-foreground/30 aria-checked:bg-muted"
                >
                  <ProviderLogo
                    kind={value}
                    className="size-5 transition-transform duration-150 ease-out group-hover/kind:scale-110"
                  />
                  <span className="font-medium">
                    {KIND_LABELS[value].replace(" compatible", "")}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="settings-name">Name</Label>
              <Input
                id="settings-name"
                value={settings.name}
                onChange={(event) => settings.setName(event.target.value)}
                maxLength={60}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="settings-base-url">Base URL</Label>
              <Input
                id="settings-base-url"
                type="url"
                value={settings.baseUrl}
                onChange={(event) => settings.setBaseUrl(event.target.value)}
                placeholder={PLACEHOLDERS[settings.kind]}
                required
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="settings-key">
              Upstream key
              <span className="ms-1 font-normal text-muted-foreground">
                {provider.hasKey ? "(saved, leave empty to keep)" : "(none saved)"}
              </span>
            </Label>
            <Input
              id="settings-key"
              type="password"
              value={settings.apiKey}
              onChange={(event) => settings.setApiKey(event.target.value)}
              placeholder={provider.hasKey ? "Saved key" : "Optional for local upstreams"}
              autoComplete="off"
            />
          </div>

          {settings.error === null ? null : (
            <p className="text-sm text-destructive">{settings.error}</p>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={!dirty || settings.pending}>
              {settings.pending ? "Saving…" : "Save changes"}
            </Button>
            {saved ? (
              <span className="text-xs text-muted-foreground">Saved.</span>
            ) : dirty ? (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

type Settings = {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly setName: (value: string) => void;
  readonly setKind: (value: ProviderKind) => void;
  readonly setBaseUrl: (value: string) => void;
  readonly setApiKey: (value: string) => void;
  readonly save: () => Promise<Provider | null>;
};

function useProviderSettings(provider: Provider): Settings {
  const [name, setName] = useState(provider.name);
  const [kind, setKind] = useState<ProviderKind>(provider.kind);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<Provider | null> => {
    setPending(true);
    setError(null);

    try {
      const updated = await providerApi.update(provider.id, {
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
      });

      setApiKey("");

      return updated;
    } catch (saveError) {
      setError(isError(saveError) ? describeError(saveError) : String(saveError));

      return null;
    } finally {
      setPending(false);
    }
  };

  return {
    name,
    kind,
    baseUrl,
    apiKey,
    pending,
    error,
    setName,
    setKind,
    setBaseUrl,
    setApiKey,
    save,
  };
}

function ModelsCard({
  provider,
  providers,
  onChanged,
}: {
  provider: Provider;
  providers: ReturnType<typeof useProviders>;
  onChanged: () => void;
}) {
  const [upstreamModel, setUpstreamModel] = useState("");
  const [alias, setAlias] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const added = await providers.addModel(provider.id, {
      upstreamModel: upstreamModel.trim(),
      alias: alias.trim() === "" ? undefined : alias.trim(),
    });

    if (added) {
      setUpstreamModel("");
      setAlias("");
      onChanged();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>
          Alias is what clients send as <code>model</code>. Leave it empty to use the upstream name.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="model-upstream" className="text-xs">
              Upstream model
            </Label>
            <Input
              id="model-upstream"
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
          <Button type="submit" size="sm" disabled={providers.pending}>
            <PlusIcon data-icon="inline-start" />
            Add
          </Button>
        </form>

        {providers.error === null ? null : (
          <p className="text-sm text-destructive">{providers.error}</p>
        )}

        {provider.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No models yet. Clients cannot use this provider until it has an alias.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {provider.models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                pending={providers.pending}
                onRemove={() => {
                  void providers.removeModel(provider.id, model.id).then(onChanged);
                }}
              />
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            Removing a provider deletes its models. Requests stay in analytics.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={providers.pending}
            onClick={() => {
              if (!window.confirm(`Remove ${provider.name} and all of its models?`)) return;

              void providers.remove(provider.id).then(() => {
                window.location.assign("/providers");
              });
            }}
          >
            <TrashIcon data-icon="inline-start" />
            Remove provider
          </Button>
        </div>
      </CardContent>
    </Card>
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
      {model.inputPricePerMtok === null && model.outputPricePerMtok === null ? null : (
        <span className="text-xs text-muted-foreground">
          {formatUsd(model.inputPricePerMtok)} in / {formatUsd(model.outputPricePerMtok)} out per M
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${model.alias}`}
        disabled={pending}
        onClick={() => {
          if (window.confirm(`Remove the alias ${model.alias}?`)) onRemove();
        }}
        className="ms-auto rounded p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,transform] duration-150 ease-out group-hover/model:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-90 disabled:pointer-events-none"
      >
        <TrashIcon className="size-3.5" />
      </button>
    </li>
  );
}

function RequestsCard({ providerId, providerName }: { providerId: string; providerName: string }) {
  const requests = useRequests(10, providerId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent requests</CardTitle>
        <CardDescription>The last 10 attempts routed to {providerName}.</CardDescription>
      </CardHeader>
      <CardContent>
        {requests.status === "loading" ? (
          <Skeleton className="h-16 w-full" />
        ) : requests.requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests to this provider yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 text-right font-medium">Tokens</th>
                  <th className="py-2 text-right font-medium">Speed</th>
                </tr>
              </thead>
              <tbody>
                {requests.requests.map((request) => (
                  <tr key={request.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                      {formatWhen(request.startedAt)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{request.model}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={
                          request.status === "success" ? "text-xs" : "text-xs text-destructive"
                        }
                      >
                        {request.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right text-xs">
                      {formatExactTokens(request.inputTokens)} /{" "}
                      {formatExactTokens(request.outputTokens)}
                    </td>
                    <td className="py-2 text-right text-xs">
                      {formatTps(request.tokensPerSecond)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{value}</p>
        {hint === undefined ? null : (
          <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}
