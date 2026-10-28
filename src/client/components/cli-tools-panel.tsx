import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CLI_TOOLS, GATEWAY_NEED_LABEL, toolStatus, type CliTool } from "@/shared/cli-tools";
import { CliToolLogo } from "./cli-tool-logo";
import { CliToolStatusChip } from "./cli-tool-parts";

export function CliToolsPanel() {
  const ready = CLI_TOOLS.filter((tool) => toolStatus(tool).status !== "blocked");
  const blocked = CLI_TOOLS.filter((tool) => toolStatus(tool).status === "blocked");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">CLI tools</h1>
        <p className="text-sm text-muted-foreground">
          Point a coding CLI at this gateway with a key, a model ref, and the config it reads.
        </p>
      </div>

      <CliToolSection
        title="Connect now"
        description="These tools reach the model through the routes this build serves."
      >
        <CliToolList tools={ready} />
      </CliToolSection>

      <CliToolSection
        title="Blocked by a missing route"
        description="These tools need a gateway route this build does not serve yet."
      >
        <CliToolList tools={blocked} />
      </CliToolSection>
    </div>
  );
}

function CliToolSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="px-0.5">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function CliToolList({ tools }: { tools: readonly CliTool[] }) {
  return (
    <Card>
      <CardContent>
        <ul className="-mx-1 divide-y">
          {tools.map((tool) => (
            <CliToolRow key={tool.id} tool={tool} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CliToolRow({ tool }: { tool: CliTool }) {
  const status = toolStatus(tool);

  return (
    <li>
      <Link
        to="/cli-tools/$toolId"
        params={{ toolId: tool.id }}
        className="group/row -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-3 rounded-lg px-2 py-3 text-start transition-colors duration-150 ease-out hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground transition-transform duration-150 ease-out group-hover/row:scale-105">
          <CliToolLogo toolId={tool.id} className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{tool.name}</span>
            <CliToolStatusChip status={status.status} />
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{tool.summary}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{tool.keyVariable}</span>
            <span aria-hidden="true">·</span>
            <span>{tool.needs.map((need) => GATEWAY_NEED_LABEL[need]).join(", ")}</span>
          </span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-hover/row:translate-x-0.5" />
      </Link>
    </li>
  );
}
