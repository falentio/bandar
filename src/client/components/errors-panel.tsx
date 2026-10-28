import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatWhen } from "../format";
import { useCooldowns } from "../use-cooldowns";
import { isCoolingDown } from "./health-badge";

export function ErrorsPanel() {
  const cooldowns = useCooldowns(100);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Errors</h1>
          <p className="text-sm text-muted-foreground">
            Every failure that pushed a provider, model, or credential into cooldown.
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
          <CardTitle>Cooldown history</CardTitle>
          <CardDescription>Last 100 failures that flagged a subject.</CardDescription>
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
                    <th className="py-2 pr-3 font-medium">Until</th>
                    <th className="py-2 font-medium">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {cooldowns.events.map((event) => (
                    <tr key={event.id} className="border-b align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {formatWhen(event.createdAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                          {event.subject}
                        </span>
                        <span className="mt-0.5 block">
                          {event.subjectName === "" ? "unnamed" : event.subjectName}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{event.providerName}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{event.modelAlias}</td>
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
                      <td className="py-2 font-mono text-xs">{event.reference}</td>
                    </tr>
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

function formatCooldown(ms: number): string {
  if (ms >= 3_600_000) return `${hoursOf(ms)}h`;

  if (ms >= 60_000) return `${String(ms / 60_000)}m`;

  return `${String(ms / 1000)}s`;
}

function hoursOf(ms: number): string {
  const value = ms / 3_600_000;

  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
