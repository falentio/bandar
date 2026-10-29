import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ANALYTICS_RANGES,
  EMPTY_ANALYTICS_FILTERS,
  hasAnalyticsFilters,
} from "../../shared/analytics";
import { formatExactTokens, formatTokens, formatTps, formatUsd } from "../format";
import { modelLabels } from "../model-labels";
import { ModelName } from "../model-name";
import { useAnalytics } from "../use-analytics";
import { useProviders } from "../use-providers";
import { AnalyticsFilterBar } from "./analytics-filters";
import { OverviewStats } from "./overview-stats";
import { TokenChart } from "./token-chart";

export function OverviewPanel() {
  const analytics = useAnalytics();
  const providers = useProviders();
  const labels = modelLabels(providers.providers);
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
          {ANALYTICS_RANGES.map((days) => (
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

      <AnalyticsFilterBar filters={analytics.filters} onChange={analytics.setFilters} />

      {analytics.error === null ? null : (
        <p className="text-sm text-destructive">{analytics.error}</p>
      )}

      {data === null ? (
        <p className="text-sm text-muted-foreground">Loading analytics…</p>
      ) : data.summary.requests === 0 ? (
        <EmptyAnalytics
          filtered={hasAnalyticsFilters(analytics.filters)}
          onClear={() => analytics.setFilters(EMPTY_ANALYTICS_FILTERS)}
        />
      ) : (
        <div
          aria-busy={analytics.status === "loading"}
          className={analytics.status === "loading" ? "space-y-4 opacity-60" : "space-y-4"}
        >
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
        </div>
      )}
    </div>
  );
}

function EmptyAnalytics({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {filtered ? "No requests match these filters" : "No requests in this window"}
        </CardTitle>
        <CardDescription>
          {filtered ? (
            "Clear a filter or widen the window to see more traffic."
          ) : (
            <>
              Connect a provider, mint an API key, then call <code>/v1/chat/completions</code>.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {filtered ? (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link to="/providers">Add a custom provider</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
