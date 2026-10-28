import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, KeyRoundIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  Provider,
  ProviderAuthMode,
  ProviderCredential,
  ProviderCredentialProbe,
} from "../../shared/providers";
import { useProviders } from "../use-providers";
import { AddCredentialDialog } from "./credential-dialog";
import { HealthBadge } from "./health-badge";

const AUTH_MODE_LABELS: Record<ProviderAuthMode, string> = {
  "api-key": "API key",
  oauth: "OAuth",
};

export function CredentialsCard({
  provider,
  providers,
  onChanged,
  onRemoveProvider,
}: {
  provider: Provider;
  providers: ReturnType<typeof useProviders>;
  onChanged: () => void;
  onRemoveProvider: () => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState<readonly string[]>([]);
  const [probes, setProbes] = useState<Readonly<Record<string, ProviderCredentialProbe>>>({});
  const copy = cardCopy(provider);

  const current = provider.credentials.map((credential) => credential.id);

  const move = async (index: number, delta: number) => {
    const next = [...current];
    const [moved] = next.splice(index, 1);

    if (moved === undefined) return;

    next.splice(index + delta, 0, moved);

    if (await providers.reorderCredentials(provider.id, next)) onChanged();
  };

  const remove = async (credentialId: string) => {
    if (await providers.removeCredential(provider.id, credentialId)) onChanged();
  };

  const test = async (credentialId: string) => {
    setTesting((running) => running.concat(credentialId));

    const probe = await providers.testCredential(provider.id, credentialId);

    setTesting((running) => running.filter((id) => id !== credentialId));

    if (probe !== null) setProbes((current) => ({ ...current, [credentialId]: probe }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon data-icon="inline-start" />
            {provider.authModes.includes("api-key") ? "Add credential" : "Connect account"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
          <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            Credentials are sealed with AES-GCM and never returned by the API, so a saved value
            cannot be shown again. Remove it and add a new one to replace it.
          </span>
        </div>

        {provider.credentials.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
            {provider.authModes.includes("api-key")
              ? "No credential saved. Requests to this provider are sent without credentials."
              : "No account connected. Requests to this provider fail until you connect one."}
          </p>
        ) : (
          <ol className="divide-y rounded-lg border">
            {provider.credentials.map((credential, index) => {
              const probe = probes[credential.id];
              const running = testing.includes(credential.id);

              return (
                <li key={credential.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
                      #{credential.priority}
                    </span>
                    <span className="text-sm font-medium">{nameOf(credential)}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                      {AUTH_MODE_LABELS[credential.authMode]}
                    </span>
                    <HealthBadge
                      failures={credential.failures}
                      flaggedUntil={credential.flaggedUntil}
                    />
                    <span className="ms-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={running}
                        onClick={() => void test(credential.id)}
                      >
                        {running ? "Testing…" : "Test"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${nameOf(credential)} up`}
                        disabled={providers.pending || index === 0}
                        onClick={() => void move(index, -1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${nameOf(credential)} down`}
                        disabled={providers.pending || index === provider.credentials.length - 1}
                        onClick={() => void move(index, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${nameOf(credential)}`}
                        disabled={providers.pending}
                        onClick={() => {
                          if (window.confirm(`Remove ${nameOf(credential)} from ${provider.name}?`))
                            void remove(credential.id);
                        }}
                      >
                        <XIcon />
                      </Button>
                    </span>
                  </div>
                  {probe === undefined ? null : <ProbeLine probe={probe} />}
                </li>
              );
            })}
          </ol>
        )}

        {providers.error === null ? null : (
          <p className="text-sm text-destructive">{providers.error}</p>
        )}

        {provider.origin === "custom" ? (
          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">
              Removing a provider deletes its models and credentials. Requests stay in analytics.
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={providers.pending || removing}
              onClick={() => {
                if (!window.confirm(`Remove ${provider.name} and all of its models?`)) return;

                setRemoving(true);
                void onRemoveProvider().finally(() => setRemoving(false));
              }}
            >
              <TrashIcon data-icon="inline-start" />
              {removing ? "Removing…" : "Remove provider"}
            </Button>
          </div>
        ) : null}
      </CardContent>
      <AddCredentialDialog
        provider={provider}
        providers={providers}
        onChanged={onChanged}
        open={adding}
        onOpenChange={setAdding}
      />
    </Card>
  );
}

function ProbeLine({ probe }: { probe: ProviderCredentialProbe }) {
  return (
    <p className="mt-1 ps-8 text-xs">
      <span className={probe.ok ? "font-medium" : "font-medium text-destructive"}>
        {probe.ok ? "ok" : "failed"}
      </span>
      <span className="text-muted-foreground">
        {` · ${probe.latencyMs} ms`}
        {probe.status === null ? "" : ` · ${probe.status}`}
      </span>
      {probe.error === null ? null : (
        <span className="mt-0.5 block break-words text-muted-foreground">{probe.error}</span>
      )}
    </p>
  );
}

type CardCopy = { readonly title: string; readonly description: string };

function cardCopy(provider: Provider): CardCopy {
  if (!provider.authModes.includes("oauth")) {
    return {
      title: "Credentials",
      description:
        "The gateway tries each credential in order. A rejected key falls back to the next one.",
    };
  }

  const description = `Connect a ${provider.name} account with a device code`;

  return {
    title: `${provider.name} connection`,
    description: provider.authModes.includes("api-key")
      ? `${description}, or save an API key. A connection joins the chain or replaces an expiring one.`
      : `${description}. A connection joins the chain or replaces an expiring one.`,
  };
}

function nameOf(credential: ProviderCredential): string {
  return credential.label === "" ? `Account ${String(credential.priority)}` : credential.label;
}
