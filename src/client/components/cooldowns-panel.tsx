import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActiveCooldown, CooldownEvent, CooldownLink } from "../../shared/cooldowns";
import { formatWhen } from "../format";
import { labelForId, modelLabels, type ModelLabels } from "../model-labels";
import { ModelName } from "../model-name";
import { useCooldowns } from "../use-cooldowns";
import { useProviders } from "../use-providers";
import { isCoolingDown } from "./health-badge";

export function CooldownsPanel() {
  const cooldowns = useCooldowns(100);
  const providers = useProviders();
  const labels = modelLabels(providers.providers);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Cooldowns</h1>
          <p className="text-sm text-muted-foreground">
            What the gateway is skipping now, and the upstream calls that flagged it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={cooldowns.refresh}>
          Refresh
        </Button>
      </div>

      {cooldowns.error === null ? null : (
        <p className="text-sm text-destructive">{cooldowns.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Cooling down now</CardTitle>
          <CardDescription>
            Subjects the gateway is skipping until their flag expires.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cooldowns.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading cooldowns…</p>
          ) : cooldowns.status === "error" ? null : cooldowns.active.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is cooling down. A failing credential, provider, or model appears here until
              its flag expires.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3 font-medium">Subject</th>
                    <th className="py-2 pr-3 font-medium">Provider</th>
                    <th className="py-2 pr-3 text-right font-medium">Failures</th>
                    <th className="py-2 pr-3 font-medium">Until</th>
                    <th className="py-2 pr-3 font-medium">Triggered by</th>
                    <th className="py-2 text-right font-medium">
                      <span className="sr-only">Upstream</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cooldowns.active.map((row) => (
                    <ActiveRow key={`${row.subject}:${row.subjectId}`} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cooldown history</CardTitle>
          <CardDescription>
            Last 100 failures that flagged a subject. A vendor reset is the refill time it named,
            and the cooldown waits for it where it outlasts the ordinary growth.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cooldowns.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading cooldown events…</p>
          ) : cooldowns.status === "error" ? null : cooldowns.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No cooldown events yet. A failing credential, provider, or model shows up here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium">Subject</th>
                    <th className="py-2 pr-3 font-medium">Provider</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 pr-3 font-medium">Error</th>
                    <th className="py-2 pr-3 font-medium">Cooldown</th>
                    <th className="py-2 pr-3 font-medium">Vendor reset</th>
                    <th className="py-2 pr-3 font-medium">Until</th>
                    <th className="py-2 pr-3 font-medium">Reference</th>
                    <th className="py-2 text-right font-medium">
                      <span className="sr-only">Upstream</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cooldowns.events.map((event) => (
                    <EventRow key={event.id} event={event} labels={labels} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ActiveRow({ row }: { row: ActiveCooldown }) {
  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2 pr-3">
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
          {row.subject}
        </span>
        <span className="mt-0.5 block">{nameOf(row.subjectName)}</span>
      </td>
      <td className="py-2 pr-3">{row.providerName}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{row.failures}</td>
      <td className="py-2 pr-3 whitespace-nowrap">
        <span className="font-medium text-destructive">cooling down</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {formatWhen(row.flaggedUntil)}
        </span>
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {row.lastEvent === null ? (
          <span className="font-sans text-muted-foreground">not captured</span>
        ) : (
          row.lastEvent.errorKind
        )}
      </td>
      <td className="py-2 text-right">
        <InspectCell link={row.lastEvent?.attempt ?? null} />
      </td>
    </tr>
  );
}

function EventRow({ event, labels }: { event: CooldownEvent; labels: ModelLabels }) {
  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
        {formatWhen(event.createdAt)}
      </td>
      <td className="py-2 pr-3">
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
          {event.subject}
        </span>
        <span className="mt-0.5 block">{subjectLabelOf(event, labels)}</span>
      </td>
      <td className="py-2 pr-3">{event.providerName}</td>
      <td className="py-2 pr-3">
        <ModelName labels={labels} modelId={event.modelId} slug={event.modelSlug} />
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {event.errorKind}
        {event.errorMessage === null ? null : (
          <span className="mt-0.5 block max-w-64 font-sans text-[0.7rem] break-words text-muted-foreground">
            {event.errorMessage}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
        {formatCooldown(event.cooldownMs)}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
        {event.resetsAt === null ? "—" : formatWhen(event.resetsAt)}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        <span
          className={
            isCoolingDown(event.flaggedUntil)
              ? "font-medium text-destructive"
              : "text-muted-foreground"
          }
        >
          {isCoolingDown(event.flaggedUntil) ? "cooling down" : "expired"}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {formatWhen(event.flaggedUntil)}
        </span>
      </td>
      <td className="py-2 pr-3 font-mono text-xs">{event.reference}</td>
      <td className="py-2 text-right">
        <InspectCell link={event.attempt} />
      </td>
    </tr>
  );
}

function InspectCell({ link }: { link: CooldownLink | null }) {
  if (link === null) return <span className="text-xs text-muted-foreground">not captured</span>;

  return (
    <Button asChild variant="outline" size="sm" className="gap-1">
      <Link
        to="/requests/$requestId/attempts/$attemptId"
        params={{ requestId: link.requestId, attemptId: link.attemptId }}
        aria-label="Inspect the upstream call"
      >
        Inspect
        <ChevronRightIcon className="size-3.5" />
      </Link>
    </Button>
  );
}

function subjectLabelOf(event: CooldownEvent, labels: ModelLabels): string {
  return nameOf(
    event.subject === "model"
      ? labelForId(labels, event.modelId, event.subjectName)
      : event.subjectName,
  );
}

function nameOf(name: string): string {
  return name === "" ? "unnamed" : name;
}

function formatCooldown(ms: number): string {
  if (ms >= 3_600_000) return `${hoursOf(ms)}h`;

  if (ms >= 60_000) return `${String(ms / 60_000)}m`;

  return `${String(ms / 1000)}s`;
}

function hoursOf(ms: number): string {
  const value = ms / 3_600_000;

  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
