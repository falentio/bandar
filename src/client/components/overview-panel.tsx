import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DailyUsage } from "../../shared/analytics";
import {
  formatDay,
  formatExactTokens,
  formatMs,
  formatPercent,
  formatTokens,
  formatTps,
  formatUsd,
} from "../format";
import { useAnalytics } from "../use-analytics";

const RANGES = [7, 30, 90] as const;

export function OverviewPanel() {
  const analytics = useAnalytics();
  const data = analytics.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Usage across every provider, measured at the gateway.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((days) => (
            <Button
              key={days}
              variant={analytics.days === days ? "default" : "outline"}
              size="sm"
              onClick={() => analytics.setDays(days)}
            >
              {days}d
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={analytics.refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {analytics.error === null ? null : (
        <p className="text-sm text-destructive">{analytics.error}</p>
      )}

      {data === null ? (
        <p className="text-sm text-muted-foreground">Loading analytics…</p>
      ) : data.summary.requests === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No requests in this window</CardTitle>
            <CardDescription>
              Connect a provider, mint an API key, then call <code>/v1/chat/completions</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to="/providers">Add a provider</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Requests" value={formatTokens(data.summary.requests)} />
            <Stat
              label="Tokens"
              value={formatTokens(data.summary.totalTokens)}
              hint={`${formatTokens(data.summary.inputTokens)} in · ${formatTokens(
                data.summary.outputTokens,
              )} out`}
            />
            <Stat label="Avg speed" value={formatTps(data.summary.avgTps)} hint="generation only" />
            <Stat label="Avg TTFT" value={formatMs(data.summary.avgTtftMs)} hint="first token" />
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Avg / day"
              value={formatTokens(data.summary.avgTokensPerDay)}
              hint={`over ${data.days} days`}
            />
            <Stat label="Error rate" value={formatPercent(data.summary.errorRate)} />
            <Stat label="p95 latency" value={formatMs(data.summary.p95DurationMs)} />
            <Stat label="Cost" value={formatUsd(data.summary.costUsd)} hint="priced models only" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Daily tokens</CardTitle>
              <CardDescription>
                Input and output tokens per day. Newest day is on the right.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TokenChart daily={data.daily} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>By model</CardTitle>
              <CardDescription>Top aliases in the selected window.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 font-medium">Kind</th>
                      <th className="py-2 pr-3 text-right font-medium">Requests</th>
                      <th className="py-2 pr-3 text-right font-medium">Tokens</th>
                      <th className="py-2 pr-3 text-right font-medium">Speed</th>
                      <th className="py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map((model) => (
                      <tr key={`${model.providerKind}:${model.model}`} className="border-b">
                        <td className="py-2 pr-3 font-mono text-xs">{model.model}</td>
                        <td className="py-2 pr-3">{model.providerKind}</td>
                        <td className="py-2 pr-3 text-right">
                          {formatExactTokens(model.requests)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {formatTokens(model.inputTokens + model.outputTokens)}
                        </td>
                        <td className="py-2 pr-3 text-right">{formatTps(model.avgTps)}</td>
                        <td className="py-2 text-right">{formatUsd(model.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        {hint === undefined ? null : <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function TokenChart({ daily }: { daily: readonly DailyUsage[] }) {
  const max = Math.max(...daily.map((day) => day.inputTokens + day.outputTokens), 1);
  const first = daily[0];
  const last = daily.at(-1);

  return (
    <div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary/40" /> input
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary" /> output
        </span>
      </div>
      <div className="mt-3 flex h-40 items-end gap-[2px]">
        {daily.map((day) => {
          const input = (day.inputTokens / max) * 100;
          const output = (day.outputTokens / max) * 100;

          return (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end"
              title={`${day.date}: ${formatExactTokens(day.inputTokens)} in, ${formatExactTokens(
                day.outputTokens,
              )} out, ${day.requests} requests`}
            >
              <div className="w-full bg-primary" style={{ height: `${output}%` }} />
              <div className="w-full bg-primary/40" style={{ height: `${input}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{first === undefined ? "" : formatDay(first.date)}</span>
        <span>{last === undefined ? "" : formatDay(last.date)}</span>
      </div>
    </div>
  );
}
