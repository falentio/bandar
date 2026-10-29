import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  renderInput,
  type CliRenderInput,
  type CliTool,
  type CliToolStatus,
} from "@/shared/cli-tools";
import { modelChoices } from "../model-options";
import { ModelCombobox } from "./model-combobox";
import { useApiKeys } from "../use-api-keys";
import { useProviders } from "../use-providers";
import { useTags } from "../use-tags";

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

export function KeyAndModelsCard({
  tool,
  origin,
  children,
}: {
  tool: CliTool;
  origin: string;
  children: (input: CliRenderInput) => ReactNode;
}) {
  const apiKeys = useApiKeys();
  const providers = useProviders();
  const tags = useTags();
  const [pastedKey, setPastedKey] = useState("");
  const [models, setModels] = useState<readonly string[]>([]);
  const busy = providers.pending || tags.pending;

  const key = apiKeys.created ?? pastedKey;
  const input = renderInput(origin, models, key);
  const choices = modelChoices(providers.providers, tags.tags);
  const single = tool.modelCapacity === "one";

  const empty =
    providers.status === "ready" &&
    tags.status === "ready" &&
    choices.tags.length === 0 &&
    choices.providers.length === 0;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{single ? "Key and model" : "Key and models"}</CardTitle>
          <CardDescription>
            {single
              ? "Create a key for this tool, or paste one you already have. Pick the model this tool starts on. Its ref goes into the config."
              : "Create a key for this tool, or paste one you already have. Pick the models this tool should offer; the first one is its default."}
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
            <div className="flex flex-col gap-1">
              <ModelCombobox
                capacity={tool.modelCapacity}
                choices={choices}
                selected={models}
                disabled={busy}
                onChange={setModels}
              />
              {empty ? (
                <p className="text-xs text-muted-foreground">
                  No models yet.{" "}
                  <Link to="/providers" className="underline underline-offset-4">
                    Add a provider
                  </Link>{" "}
                  or{" "}
                  <Link to="/tags" className="underline underline-offset-4">
                    build a tag
                  </Link>{" "}
                  first.
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={apiKeys.pending}
              onClick={() => void apiKeys.create(`cli-${tool.id}`)}
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
