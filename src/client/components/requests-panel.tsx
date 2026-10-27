import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatExactTokens, formatMs, formatTps, formatUsd, formatWhen } from "../format";
import { useRequests } from "../use-requests";

export function RequestsPanel() {
  const requests = useRequests(50);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Requests</h1>
          <p className="text-sm text-muted-foreground">
            The latest gateway attempts, including failures and aborts.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={requests.refresh}>
          Refresh
        </Button>
      </div>

      {requests.error === null ? null : (
        <p className="text-sm text-destructive">{requests.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent requests</CardTitle>
          <CardDescription>Last 50 attempts for this account.</CardDescription>
        </CardHeader>
        <CardContent>
          {requests.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading requests…</p>
          ) : requests.requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 text-right font-medium">In</th>
                    <th className="py-2 pr-3 text-right font-medium">Out</th>
                    <th className="py-2 pr-3 text-right font-medium">TTFT</th>
                    <th className="py-2 pr-3 text-right font-medium">Speed</th>
                    <th className="py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.requests.map((request) => (
                    <tr key={request.id} className="border-b">
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {formatWhen(request.startedAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="font-mono text-xs">{request.model}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {request.providerKind}
                          {request.streamed ? "" : " · sync"}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusLabel status={request.status} />
                        {request.errorKind === null ? null : (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {request.errorKind}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatExactTokens(request.inputTokens)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatExactTokens(request.outputTokens)}
                      </td>
                      <td className="py-2 pr-3 text-right">{formatMs(request.ttftMs)}</td>
                      <td className="py-2 pr-3 text-right">{formatTps(request.tokensPerSecond)}</td>
                      <td className="py-2 text-right">{formatUsd(request.costUsd)}</td>
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

function StatusLabel({ status }: { status: string }) {
  const tone =
    status === "success"
      ? "text-primary"
      : status === "error"
        ? "text-destructive"
        : "text-muted-foreground";

  return <span className={`font-medium ${tone}`}>{status}</span>;
}
