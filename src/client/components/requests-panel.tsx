import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DownstreamRequest, RequestEvent } from "../../shared/analytics";
import { formatExactTokens, formatMs, formatTps, formatUsd, formatWhen } from "../format";
import { modelLabels } from "../model-labels";
import { ModelName } from "../model-name";
import { useProviders } from "../use-providers";
import { useRequests } from "../use-requests";

export function RequestsPanel() {
  const requests = useRequests(50);
  const providers = useProviders();
  const labels = modelLabels(providers.providers);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Requests</h1>
          <p className="text-sm text-muted-foreground">
            The latest calls into the gateway, with every upstream attempt each one made.
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
                    <th className="py-2 pr-3 text-right font-medium">In</th>
                    <th className="py-2 pr-3 text-right font-medium">Out</th>
                    <th className="py-2 pr-3 text-right font-medium">TTFT</th>
                    <th className="py-2 pr-3 text-right font-medium">Speed</th>
                    <th className="py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.requests.map((request) => (
                    <RequestRow key={request.id} request={request} labels={labels} />
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

function RequestRow({
  request,
  labels,
}: {
  request: DownstreamRequest;
  labels: ReturnType<typeof modelLabels>;
}) {
  const [open, setOpen] = useState(request.attempts.length === 1);

  return (
    <>
      <tr className="border-b align-top">
        <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
          <div className="flex items-center gap-1">
            {request.attempts.length === 1 ? (
              <span className="w-4" />
            ) : (
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-label={open ? "Hide attempts" : "Show attempts"}
                className="w-4 text-muted-foreground hover:text-foreground"
              >
                {open ? "▾" : "▸"}
              </button>
            )}
            {formatWhen(request.startedAt)}
          </div>
        </td>
        <td className="py-2 pr-3">
          <span className="block text-xs">
            {request.reference === null ? (
              <span className="text-muted-foreground">{request.attempts.length} attempts</span>
            ) : (
              <span className="font-mono">{request.reference}</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {request.streamed ? "streamed" : "sync"}
            {request.attempts.length > 1 ? ` · ${request.attempts.length} attempts` : ""}
          </span>
        </td>
        <td className="py-2 pr-3">
          <StatusLabel status={request.status} />
          {request.attempts.length > 1 ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {failuresSuffix(request)}
            </span>
          ) : null}
        </td>
        <td className="py-2 pr-3 text-right">
          {formatExactTokens(totalOf(request, "inputTokens"))}
        </td>
        <td className="py-2 pr-3 text-right">
          {formatExactTokens(totalOf(request, "outputTokens"))}
        </td>
        <td className="py-2 pr-3 text-right text-muted-foreground">—</td>
        <td className="py-2 pr-3 text-right text-muted-foreground">—</td>
        <td className="py-2 text-right">{formatUsd(totalOf(request, "costUsd"))}</td>
      </tr>

      {open
        ? request.attempts.map((attempt, index) => (
            <AttemptRow
              key={attempt.id}
              attempt={attempt}
              position={index + 1}
              nested={request.attempts.length > 1}
              labels={labels}
            />
          ))
        : null}
    </>
  );
}

function AttemptRow({
  attempt,
  position,
  nested,
  labels,
}: {
  attempt: RequestEvent;
  position: number;
  nested: boolean;
  labels: ReturnType<typeof modelLabels>;
}) {
  return (
    <tr className="border-b bg-muted/30 align-top">
      <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
        <span className="block pl-5">{nested ? `#${position}` : ""}</span>
      </td>
      <td className="py-2 pr-3">
        <ModelName labels={labels} slug={attempt.model} className="text-xs" />
        {attempt.reference === null || attempt.reference === attempt.model ? null : (
          <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
            {attempt.reference}
          </span>
        )}
        <span className="mt-0.5 block text-xs text-muted-foreground">{attempt.providerKind}</span>
      </td>
      <td className="py-2 pr-3">
        <StatusLabel status={attempt.status} />
        {attempt.errorKind === null ? null : (
          <span className="mt-0.5 block text-xs text-muted-foreground">{attempt.errorKind}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-right">{formatExactTokens(attempt.inputTokens)}</td>
      <td className="py-2 pr-3 text-right">{formatExactTokens(attempt.outputTokens)}</td>
      <td className="py-2 pr-3 text-right">{formatMs(attempt.ttftMs)}</td>
      <td className="py-2 pr-3 text-right">{formatTps(attempt.tokensPerSecond)}</td>
      <td className="py-2 text-right">{formatUsd(attempt.costUsd)}</td>
    </tr>
  );
}

function failuresSuffix(request: DownstreamRequest): string {
  const failed = request.attempts.filter((attempt) => attempt.status !== "success").length;

  if (failed === 0) return `${request.attempts.length} attempts, all succeeded`;

  return `${failed} of ${request.attempts.length} attempts failed`;
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
