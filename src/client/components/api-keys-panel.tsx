import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { API_KEY_HEADER, API_KEY_NAME_MAX } from "@/shared/api-keys";
import { useApiKeys } from "../use-api-keys";

export function ApiKeysPanel() {
  const apiKeys = useApiKeys();
  const [name, setName] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();

    if (!trimmed) return;

    setName("");
    await apiKeys.create(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Send a key as <code>Authorization: Bearer &lt;key&gt;</code> (or the {API_KEY_HEADER}{" "}
          header) to the gateway. Keys are shown once and can call every model you configure.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={API_KEY_NAME_MAX}
            placeholder="Key name"
            aria-label="Key name"
            disabled={apiKeys.pending}
          />
          <Button type="submit" disabled={apiKeys.pending || name.trim() === ""}>
            Create
          </Button>
        </form>

        {apiKeys.created === null ? null : (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <code className="block font-mono text-xs break-all">{apiKeys.created}</code>
            <p className="text-xs text-muted-foreground">
              This is the only time the key is shown. Store it now.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={apiKeys.dismissCreated}>
              Dismiss
            </Button>
          </div>
        )}

        <div className="space-y-1 rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium">Try it</p>
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {`curl ${window.location.origin}/v1/chat/completions \
  -H "Authorization: Bearer bandar_..." \
  -H "content-type: application/json" \
  -d '{"model":"your-address","messages":[{"role":"user","content":"hello"}]}'`}
          </pre>
        </div>

        {apiKeys.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading keys…</p>
        ) : null}

        {apiKeys.error === null ? null : (
          <p className="text-sm text-destructive">{apiKeys.error}</p>
        )}

        {apiKeys.status === "ready" && apiKeys.keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No API keys yet.</p>
        ) : null}

        {apiKeys.keys.length === 0 ? null : (
          <ul className="divide-y">
            {apiKeys.keys.map((key) => (
              <li key={key.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{key.name ?? "Unnamed key"}</p>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    {key.start === null ? "…" : `${key.start}…`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={apiKeys.pending}
                  onClick={() => void apiKeys.revoke(key.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
