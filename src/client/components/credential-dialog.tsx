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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_API_KEY_LENGTH,
  MAX_BULK_CREDENTIALS,
  PROVIDER_AUTH_MODES,
  type Provider,
  type ProviderAuthMode,
} from "../../shared/providers";
import type { Providers } from "../use-providers";
import { ConnectFlow } from "./connect-flow";

const CREDENTIAL_TABS = ["single", "bulk", "oauth"] as const;

type CredentialTab = (typeof CREDENTIAL_TABS)[number];

const TAB_LABELS: Record<CredentialTab, string> = {
  single: "Single",
  bulk: "Bulk",
  oauth: "OAuth",
};

const TABS_BY_AUTH_MODE: Record<ProviderAuthMode, readonly CredentialTab[]> = {
  "api-key": ["single", "bulk"],
  oauth: ["oauth"],
};

export function AddCredentialDialog({
  provider,
  providers,
  onChanged,
  open,
  onOpenChange,
}: {
  provider: Provider;
  providers: Providers;
  onChanged: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tabs = credentialTabs(provider.authModes);
  const firstTab = tabs[0] ?? "single";
  const [tab, setTab] = useState<CredentialTab>(firstTab);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [bulkText, setBulkText] = useState("");

  const apiKeys = parseApiKeys(bulkText);

  const reset = () => {
    setTab(firstTab);
    setLabel("");
    setApiKey("");
    setBulkText("");
  };

  const finish = () => {
    reset();
    onChanged();
    onOpenChange(false);
  };

  const submitSingle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const added = await providers.addCredential(provider.id, {
      label: label.trim() === "" ? undefined : label.trim(),
      apiKey: apiKey.trim(),
    });

    if (added) finish();
  };

  const submitBulk = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (apiKeys.length === 0 || apiKeys.length > MAX_BULK_CREDENTIALS) return;

    if (await providers.addCredentials(provider.id, apiKeys)) finish();
  };

  const singleForm = (
    <form onSubmit={(event) => void submitSingle(event)} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="credential-label">Label</Label>
        <Input
          id="credential-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="work"
          maxLength={60}
          autoFocus
          disabled={providers.pending}
        />
        <p className="text-xs text-muted-foreground">
          Optional. An unlabelled credential is named after its place in the chain.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="credential-key">API key</Label>
        <Input
          id="credential-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          maxLength={MAX_API_KEY_LENGTH}
          disabled={providers.pending}
        />
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="ghost" disabled={providers.pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={providers.pending || apiKey.trim() === ""}>
          Add credential
        </Button>
      </DialogFooter>
    </form>
  );

  const bulkForm = (
    <form onSubmit={(event) => void submitBulk(event)} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="credential-bulk">API keys</Label>
        <Textarea
          id="credential-bulk"
          value={bulkText}
          onChange={(event) => setBulkText(event.target.value)}
          placeholder={"sk-…\nsk-…"}
          rows={6}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={providers.pending}
        />
        <p className="text-xs text-muted-foreground">{bulkHint(apiKeys.length)}</p>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="ghost" disabled={providers.pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={
            providers.pending || apiKeys.length === 0 || apiKeys.length > MAX_BULK_CREDENTIALS
          }
        >
          {apiKeys.length > 1 ? `Add ${String(apiKeys.length)} credentials` : "Add credential"}
        </Button>
      </DialogFooter>
    </form>
  );

  const oauthForm = (
    <ConnectFlow
      provider={provider}
      onConnected={(updated) => {
        providers.apply(updated);
        onChanged();
      }}
    />
  );

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
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>
            A new credential joins the end of the chain for {provider.name}.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isCredentialTab(value)) setTab(value);
          }}
        >
          {tabs.length > 1 ? (
            <TabsList>
              {tabs.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {TAB_LABELS[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          ) : null}
          {tabs.map((value) => (
            <TabsContent key={value} value={value}>
              {value === "single" ? singleForm : null}
              {value === "bulk" ? bulkForm : null}
              {value === "oauth" ? oauthForm : null}
            </TabsContent>
          ))}
        </Tabs>
        {providers.error === null ? null : (
          <p className="text-sm text-destructive">{providers.error}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function credentialTabs(authModes: readonly ProviderAuthMode[]): readonly CredentialTab[] {
  return PROVIDER_AUTH_MODES.filter((mode) => authModes.includes(mode)).flatMap(
    (mode) => TABS_BY_AUTH_MODE[mode],
  );
}

function isCredentialTab(value: string): value is CredentialTab {
  return CREDENTIAL_TABS.some((tab) => tab === value);
}

function parseApiKeys(text: string): readonly string[] {
  const unique = new Set<string>();

  for (const line of text.split("\n")) {
    const key = line.trim();

    if (key !== "") unique.add(key);
  }

  return [...unique];
}

function bulkHint(count: number): string {
  if (count === 0) return "One key per line. Blank lines and repeats are dropped.";

  if (count > MAX_BULK_CREDENTIALS)
    return `At most ${String(MAX_BULK_CREDENTIALS)} keys at a time.`;

  return `${String(count)} ready to add.`;
}
