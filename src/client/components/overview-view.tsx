import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ANALYTICS_RANGES, type Analytics, type AnalyticsRange } from "../../shared/analytics";
import { formatExactTokens, formatTokens, formatTps, formatUsd } from "../format";
import type { ModelLabels } from "../model-labels";
import { ModelName } from "../model-name";
import { OverviewStats } from "./overview-stats";
import { TokenChart } from "./token-chart";

export function OverviewHeader({
  days,
  onDays,
  onRefresh,
}: {
  readonly days: AnalyticsRange;
  readonly onDays: (days: AnalyticsRange) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Usage across every provider, measured at the gateway.
        </p>
      </div>
      <div className="flex items-center gap-1">
        {ANALYTICS_RANGES.map((range) => (
          <Button
            key={range}
            variant={days === range ? "default" : "outline"}
            size="sm"
            onClick={() => onDays(range)}
          >
            {range}d
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

export function OverviewContent({
  data,
  busy,
  labels,
}: {
  readonly data: Analytics;
  readonly busy: boolean;
  readonly labels: ModelLabels;
}) {
  return (
    <div aria-busy={busy} className={busy ? "space-y-4 opacity-60" : "space-y-4"}>
      <OverviewStats summary={data.summary} daily={data.daily} days={data.days} />

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
          <CardDescription>Top models in the selected window.</CardDescription>
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
                    <td className="py-2 pr-3">
                      <ModelName labels={labels} slug={model.model} />
                    </td>
                    <td className="py-2 pr-3">{model.providerKind}</td>
                    <td className="py-2 pr-3 text-right">{formatExactTokens(model.requests)}</td>
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
    </div>
  );
}
