import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EMPTY_ANALYTICS_FILTERS, hasAnalyticsFilters } from "../../shared/analytics";
import { modelLabels } from "../model-labels";
import { useAnalytics } from "../use-analytics";
import { useProviders } from "../use-providers";
import { AnalyticsFilterBar } from "./analytics-filters";
import { OverviewContent, OverviewHeader } from "./overview-view";

export function OverviewPanel() {
  const analytics = useAnalytics();
  const providers = useProviders();
  const labels = modelLabels(providers.providers);
  const data = analytics.data;

  return (
    <div className="space-y-4">
      <OverviewHeader
        days={analytics.days}
        onDays={analytics.setDays}
        onRefresh={analytics.refresh}
      />

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
        <OverviewContent data={data} busy={analytics.status === "loading"} labels={labels} />
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
