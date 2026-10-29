import { Card, CardContent } from "@/components/ui/card";
import type { AnalyticsSummary, DailyUsage } from "../../shared/analytics";
import { formatMs, formatPercent, formatTokens, formatTps, formatUsd } from "../format";

export function OverviewStats({
  summary,
  daily,
  days,
}: {
  readonly summary: AnalyticsSummary;
  readonly daily: readonly DailyUsage[];
  readonly days: number;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Tokens
            </p>
            <p className="mt-1 text-4xl leading-none font-semibold tracking-tight tabular-nums">
              {formatTokens(summary.totalTokens)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {formatTokens(summary.inputTokens)} in · {formatTokens(summary.outputTokens)} out
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <TokenSparkline daily={daily} />
            <p className="text-[11px] text-muted-foreground">last {String(days)} days</p>
          </div>
        </div>

        <TokenSplitBar input={summary.inputTokens} output={summary.outputTokens} />

        <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
          <span className="text-foreground tabular-nums">{formatTokens(summary.requests)}</span>
          <span>requests</span>
          <span aria-hidden="true">·</span>
          <span className="text-foreground tabular-nums">
            {formatTokens(summary.avgTokensPerDay)}
          </span>
          <span>tokens per day</span>
          <span aria-hidden="true">·</span>
          <span className="text-foreground tabular-nums">{formatUsd(summary.costUsd)}</span>
          <span>spent</span>
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 sm:grid-cols-4">
          <RailStat label="Avg speed" value={formatTps(summary.avgTps)} />
          <RailStat label="Avg TTFT" value={formatMs(summary.avgTtftMs)} />
          <RailStat label="p95 latency" value={formatMs(summary.p95DurationMs)} />
          <RailStat label="Error rate" value={formatPercent(summary.errorRate)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function RailStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-xl leading-tight font-semibold tracking-tight tabular-nums">{value}</dd>
    </div>
  );
}

function TokenSplitBar({ input, output }: { readonly input: number; readonly output: number }) {
  const total = input + output;

  return (
    <div className="mt-4 flex h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {total === 0 ? null : (
        <>
          <div
            className="bg-foreground/25"
            style={{ width: `${String((input / total) * 100)}%` }}
          />
          <div
            className="bg-foreground/70"
            style={{ width: `${String((output / total) * 100)}%` }}
          />
        </>
      )}
    </div>
  );
}

function TokenSparkline({ daily }: { readonly daily: readonly DailyUsage[] }) {
  const points = daily.map((day) => day.inputTokens + day.outputTokens);
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? 100 / (points.length - 1) : 0;

  const line = points
    .map((value, index) => `${(index * step).toFixed(2)},${(26 - (value / max) * 24).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="h-7 w-24 text-foreground/35"
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
