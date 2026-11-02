import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DownstreamRequest, RequestEvent } from "../../shared/analytics";
import { formatExactTokens, formatMs, formatTps, formatUsd, formatWhen } from "../format";
import { modelLabels } from "../model-labels";
import { ModelName } from "../model-name";
import { useProviders } from "../use-providers";
import { useRequest } from "../use-requests";

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const detail = useRequest(requestId);
  const providers = useProviders();
  const labels = modelLabels(providers.providers);

  return (
    <div className="space-y-4">
      <Link
        to="/requests"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All requests
      </Link>

      {detail.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading request…</p>
      ) : detail.request === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Request not available</CardTitle>
            <CardDescription>
              {detail.error ?? "There is no request at this address."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to="/requests">Back to requests</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Detail request={detail.request} labels={labels} />
      )}
    </div>
  );
}

function Detail({
  request,
  labels,
}: {
  request: DownstreamRequest;
  labels: ReturnType<typeof modelLabels>;
}) {
  const failed = request.attempts.filter((attempt) => attempt.status !== "success").length;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">
            {request.reference ?? `Request ${request.id.slice(0, 8)}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatWhen(request.startedAt)} · {request.streamed ? "streamed" : "sync"} ·{" "}
            {request.attempts.length === 1
              ? "1 upstream attempt"
              : `${request.attempts.length} upstream attempts`}
            {failed === 0 ? "" : ` · ${failed} failed`}
          </p>
        </div>
        <StatusLabel status={request.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upstream attempts</CardTitle>
          <CardDescription>
            Every provider this call tried, in the order it tried them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 text-right font-medium">In</th>
                  <th className="py-2 pr-3 text-right font-medium">Out</th>
                  <th className="py-2 pr-3 text-right font-medium">TTFT</th>
                  <th className="py-2 pr-3 text-right font-medium">Speed</th>
                  <th className="py-2 pr-3 text-right font-medium">Cost</th>
                  <th className="py-2 text-right font-medium">
                    <span className="sr-only">Exchange</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {request.attempts.map((attempt, index) => (
                  <AttemptRow
                    key={attempt.id}
                    requestId={request.id}
                    attempt={attempt}
                    position={index + 1}
                    labels={labels}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Call</CardTitle>
          <CardDescription>The inbound call these attempts belong to.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Request id" value={request.id} mono />
            <Fact label="API key" value={request.apiKeyId} mono />
            <Fact label="Project" value={request.projectUrl} mono />
            <Fact label="Session" value={request.sessionId} mono />
          </dl>
        </CardContent>
      </Card>
    </>
  );
}

function Fact({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 truncate font-mono text-xs" : "min-w-0 truncate"}>
        {value ?? "—"}
      </dd>
    </div>
  );
}

function AttemptRow({
  requestId,
  attempt,
  position,
  labels,
}: {
  requestId: string;
  attempt: RequestEvent;
  position: number;
  labels: ReturnType<typeof modelLabels>;
}) {
  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2 pr-3 text-muted-foreground">{position}</td>
      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
        {formatWhen(attempt.startedAt)}
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
      <td className="py-2 pr-3 text-right">{formatUsd(attempt.costUsd)}</td>
      <td className="py-2 text-right">
        <Button asChild variant="outline" size="sm" className="gap-1">
          <Link
            to="/requests/$requestId/attempts/$attemptId"
            params={{ requestId, attemptId: attempt.id }}
            aria-label={`Inspect attempt ${position}`}
          >
            Inspect
            <ChevronRightIcon className="size-3.5" />
          </Link>
        </Button>
      </td>
    </tr>
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
