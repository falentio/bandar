import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  CLI_TOOL_IDS,
  toolById,
  toolStatus,
  type CliRenderInput,
  type CliTool,
} from "@/shared/cli-tools";
import { CliToolStatusChip, CopyButton, KeyAndModelCard } from "./cli-tool-parts";

export function CliToolPage({ toolId }: { toolId: string }) {
  const tool = cliToolOf(toolId);
  const origin = window.location.origin;

  return (
    <div className="space-y-4">
      <Link
        to="/cli-tools"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All CLI tools
      </Link>

      {tool === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Tool not available</CardTitle>
            <CardDescription>There is no CLI tool at this address.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to="/cli-tools">Back to CLI tools</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ToolPage tool={tool} origin={origin} />
      )}
    </div>
  );
}

function ToolPage({ tool, origin }: { tool: CliTool; origin: string }) {
  const status = toolStatus(tool);
  const baseUrl = tool.baseUrl(origin);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted">
            <TerminalIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{tool.name}</h1>
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <span>{tool.summary}</span>
              <span aria-hidden="true">·</span>
              <code className="font-mono text-xs">{baseUrl}</code>
            </p>
          </div>
        </div>
        <CopyButton text={baseUrl} label={`Copy base URL for ${tool.name}`} />
      </div>

      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <CliToolStatusChip status={status.status} />
        <span className="text-muted-foreground">{status.reason}</span>
      </p>

      <KeyAndModelCard toolId={tool.id} origin={origin}>
        {(input) => <ToolGuide tool={tool} input={input} />}
      </KeyAndModelCard>
    </>
  );
}

function ToolGuide({ tool, input }: { tool: CliTool; input: CliRenderInput }) {
  return (
    <div className="flex flex-col gap-4">
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
    </div>
  );
}

function cliToolOf(toolId: string): CliTool | null {
  const id = CLI_TOOL_IDS.find((entry) => entry === toolId);

  return id === undefined ? null : toolById(id);
}
