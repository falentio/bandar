import { type FormEvent, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, KeyRoundIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Provider, ProviderAuthMode, ProviderCredential } from "../../shared/providers";
import { useProviders } from "../use-providers";
import { ConnectFlow } from "./connect-flow";

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
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [removing, setRemoving] = useState(false);

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

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const added = await providers.addCredential(provider.id, {
      label: label.trim() === "" ? undefined : label.trim(),
      apiKey: apiKey.trim(),
    });

    if (!added) return;

    setLabel("");
    setApiKey("");
    onChanged();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {provider.kind === "kilocode" ? "Kilo Code connection" : "Credentials"}
        </CardTitle>
        <CardDescription>
          {provider.kind === "kilocode"
            ? "Connect a Kilo Code account with a device code, or save an API key. Each connection joins the chain."
            : "The gateway tries each credential in order. A rejected key falls back to the next one."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {provider.kind === "kilocode" ? (
          <ConnectFlow
            provider={provider}
            onConnected={(updated) => {
              providers.apply(updated);
              onChanged();
            }}
          />
        ) : null}

        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
          <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            Credentials are sealed with AES-GCM and never returned by the API, so a saved value
            cannot be shown again. To change a key, remove the credential and add a new one.
          </span>
        </div>

        {provider.credentials.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No credential saved. Requests to this provider are sent without credentials.
          </p>
        ) : (
          <ol className="divide-y rounded-lg border">
            {provider.credentials.map((credential, index) => (
              <li key={credential.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
                    #{credential.priority}
                  </span>
                  <span className="text-sm font-medium">{nameOf(credential)}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                    {AUTH_MODE_LABELS[credential.authMode]}
                  </span>
                  <span className="ms-auto flex items-center gap-1">
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
              </li>
            ))}
          </ol>
        )}

        <form
          onSubmit={(event) => void add(event)}
          className="grid gap-3 border-t pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="credential-label" className="text-xs">
              Label
            </Label>
            <Input
              id="credential-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="work"
              maxLength={60}
              disabled={providers.pending}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="credential-key" className="text-xs">
              API key
            </Label>
            <Input
              id="credential-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              maxLength={500}
              disabled={providers.pending}
            />
          </div>
          <Button type="submit" size="sm" disabled={providers.pending || apiKey.trim() === ""}>
            <PlusIcon data-icon="inline-start" />
            Add credential
          </Button>
        </form>

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
    </Card>
  );
}

function nameOf(credential: ProviderCredential): string {
  return credential.label === "" ? `Account ${String(credential.priority)}` : credential.label;
}
