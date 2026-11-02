import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DownstreamRequest } from "../../shared/analytics";
import { formatExactTokens, formatUsd, formatWhen } from "../format";
import { useRequests } from "../use-requests";

export function RequestsPanel() {
  const requests = useRequests(50);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Requests</h1>
          <p className="text-sm text-muted-foreground">
            The latest calls into the gateway. Open one to see the upstream attempts it made.
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
          <CardDescription>Last 50 calls for this account, newest first.</CardDescription>
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
                    <th className="py-2 pr-3 font-medium">Request</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 text-right font-medium">Attempts</th>
                    <th className="py-2 pr-3 text-right font-medium">In</th>
                    <th className="py-2 pr-3 text-right font-medium">Out</th>
                    <th className="py-2 pr-3 text-right font-medium">Cost</th>
                    <th className="py-2 text-right font-medium">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {requests.requests.map((request) => (
                    <RequestRow key={request.id} request={request} />
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

function RequestRow({ request }: { request: DownstreamRequest }) {
  const failed = request.attempts.filter((attempt) => attempt.status !== "success").length;

  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
        {formatWhen(request.startedAt)}
      </td>
      <td className="py-2 pr-3">
        <span className="block font-mono text-xs">
          {request.reference ?? `Request ${request.id.slice(0, 8)}`}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {request.streamed ? "streamed" : "sync"}
        </span>
      </td>
      <td className="py-2 pr-3">
        <StatusLabel status={request.status} />
        {failed === 0 ? null : (
          <span className="mt-0.5 block text-xs text-muted-foreground">{failed} failed</span>
        )}
      </td>
      <td className="py-2 pr-3 text-right">{request.attempts.length}</td>
      <td className="py-2 pr-3 text-right">{formatExactTokens(totalOf(request, "inputTokens"))}</td>
      <td className="py-2 pr-3 text-right">
        {formatExactTokens(totalOf(request, "outputTokens"))}
      </td>
      <td className="py-2 pr-3 text-right">{formatUsd(totalOf(request, "costUsd"))}</td>
      <td className="py-2 text-right">
        <Button asChild variant="outline" size="sm" className="gap-1">
          <Link
            to="/requests/$requestId"
            params={{ requestId: request.id }}
            aria-label={`Open request ${request.reference ?? request.id}`}
          >
            View
            <ChevronRightIcon className="size-3.5" />
          </Link>
        </Button>
      </td>
    </tr>
  );
}

type TotalField = "inputTokens" | "outputTokens" | "costUsd";

function totalOf(request: DownstreamRequest, field: TotalField): number | null {
  const values = request.attempts
    .map((attempt) => attempt[field])
    .filter((value): value is number => value !== null);

  if (values.length === 0) return null;

  return values.reduce((sum, value) => sum + value, 0);
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
