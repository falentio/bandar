import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  renderInput,
  type CliRenderInput,
  type CliToolId,
  type CliToolStatus,
} from "@/shared/cli-tools";
import { useApiKeys } from "../use-api-keys";

const STATUS_LABEL: Record<CliToolStatus["status"], string> = {
  ready: "Ready",
  partial: "Partial",
  blocked: "Blocked",
};

const STATUS_CLASS: Record<CliToolStatus["status"], string> = {
  ready: "text-foreground",
  partial: "text-muted-foreground",
  blocked: "text-destructive",
};

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

export function CliToolStatusChip({ status }: { status: CliToolStatus["status"] }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[0.7rem] font-medium ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function KeyAndModelCard({
  toolId,
  origin,
  children,
}: {
  toolId: CliToolId;
  origin: string;
  children: (input: CliRenderInput) => ReactNode;
}) {
  const apiKeys = useApiKeys();
  const [pastedKey, setPastedKey] = useState("");
  const [model, setModel] = useState("");

  const key = apiKeys.created ?? pastedKey;
  const input = renderInput(origin, model, key);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Key and model</CardTitle>
          <CardDescription>
            Create a key for this tool, or paste one you already have. The model ref is an alias, a
            provider ref, or a tag ref that bandar resolves.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">API key</span>
              <Input
                type="password"
                value={key}
                onChange={(event) => setPastedKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="bandar_..."
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Model ref</span>
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="sonnet"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={apiKeys.pending}
              onClick={() => void apiKeys.create(`cli-${toolId}`)}
            >
              Create key
            </Button>
            <Link to="/api-keys" className="text-xs underline underline-offset-4">
              List or revoke keys
            </Link>
            <p className="text-xs text-muted-foreground">
              The key stays in this browser tab. bandar stores a hash, so the dashboard cannot show
              it again.
            </p>
          </div>

          {apiKeys.created === null ? null : (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3">
              <p className="text-xs font-medium">
                Copy this key now. bandar stores a hash and cannot show it again.
              </p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 font-mono text-xs break-all">
                  {apiKeys.created}
                </code>
                <CopyButton text={apiKeys.created} label="Copy key" />
                <Button type="button" variant="outline" size="sm" onClick={apiKeys.dismissCreated}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          {apiKeys.error === null ? null : (
            <p className="text-sm text-destructive">{apiKeys.error}</p>
          )}
        </CardContent>
      </Card>
      {children(input)}
    </>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    setState((await writeClipboard(text)) ? "copied" : "failed");

    if (timer.current !== null) clearTimeout(timer.current);

    timer.current = setTimeout(() => setState("idle"), 1500);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => void copy()}
    >
      {COPY_LABEL[state]}
    </Button>
  );
}

/** The clipboard API needs a secure context, and a tailnet host over plain HTTP is not one. */
async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);

      return true;
    } catch {
      // Denied permission falls through to the selection fallback.
    }
  }

  const area = document.createElement("textarea");

  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();

  try {
    return document.execCommand("copy");
  } finally {
    area.remove();
  }
}
