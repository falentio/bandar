import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CLI_TOOL_IDS,
  CLI_TOOLS,
  renderInput,
  toolStatus,
  type CliRenderInput,
  type CliTool,
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

export function CliToolsPanel() {
  const apiKeys = useApiKeys();
  const [activeToolId, setActiveToolId] = useState<CliToolId>(CLI_TOOL_IDS[0]);
  const [pastedKey, setPastedKey] = useState("");
  const [model, setModel] = useState("");

  const key = apiKeys.created ?? pastedKey;
  const input = renderInput(window.location.origin, model, key);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">CLI tools</h1>
        <p className="text-sm text-muted-foreground">
          Point a coding CLI at this gateway with a key, a model ref, and the config it reads.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Key and model</CardTitle>
          <CardDescription>
            Create a key for the tool on its tab, or paste one you already have. The model ref is an
            alias, a provider ref, or a tag ref that bandar resolves.
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
              onClick={() => void apiKeys.create(`cli-${activeToolId}`)}
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

      <Card>
        <CardHeader>
          <CardTitle>Coding tools</CardTitle>
          <CardDescription>
            One tab per tool. Every tab reads the key and the model ref above.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs
            value={activeToolId}
            onValueChange={(value) => {
              const next = CLI_TOOLS.find((tool) => tool.id === value);

              if (next !== undefined) setActiveToolId(next.id);
            }}
          >
            <TabsList>
              {CLI_TOOLS.map((tool) => (
                <TabsTrigger key={tool.id} value={tool.id}>
                  {tool.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {CLI_TOOLS.map((tool) => (
              <TabsContent key={tool.id} value={tool.id}>
                <ToolTab tool={tool} input={input} />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function ToolTab({ tool, input }: { tool: CliTool; input: CliRenderInput }) {
  const status = toolStatus(tool);
  const baseUrl = tool.baseUrl(input.origin);

  return (
    <>
      <div>
        <p className="text-sm font-medium">{tool.name}</p>
        <p className="text-sm text-muted-foreground">{tool.summary}</p>
      </div>

      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className={`font-medium ${STATUS_CLASS[status.status]}`}>
          {STATUS_LABEL[status.status]}
        </span>
        <span className="text-muted-foreground">{status.reason}</span>
      </p>

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3">
        <span className="text-xs text-muted-foreground">Base URL</span>
        <code className="min-w-0 flex-1 font-mono text-xs break-all">{baseUrl}</code>
        <CopyButton text={baseUrl} label={`Copy base URL for ${tool.name}`} />
      </div>

      <Separator />

      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {tool.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="space-y-3">
        {tool.snippets(input).map((snippet) => (
          <div key={snippet.label} className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {snippet.label}
                  {snippet.kind === "file" ? (
                    <span className="ml-2 text-muted-foreground uppercase">{snippet.language}</span>
                  ) : null}
                </p>
                {snippet.kind === "file" ? (
                  <p className="font-mono text-xs break-all text-muted-foreground">
                    {snippet.path}
                  </p>
                ) : null}
              </div>
              <CopyButton text={snippet.code} label={`Copy ${snippet.label} for ${tool.name}`} />
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap break-words">{snippet.code}</pre>
          </div>
        ))}
      </div>

      <a
        href={tool.docsUrl}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-medium underline underline-offset-4"
      >
        {tool.name} docs
      </a>
    </>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
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
