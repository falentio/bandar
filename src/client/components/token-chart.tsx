import { Bar, BarChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { Analytics } from "../../shared/analytics";
import { formatBucket, formatExactTokens, formatTokens } from "../format";

export const tokenSeries = {
  inputTokens: { label: "Input", color: "var(--chart-2)" },
  outputTokens: { label: "Output", color: "var(--chart-5)" },
} satisfies ChartConfig;

export function TokenChart({ usage }: { usage: Analytics }) {
  const requestsByBucket = new Map(
    usage.buckets.map((bucket): [string, number] => [bucket.start, bucket.requests]),
  );

  return (
    <ChartContainer config={tokenSeries} className="aspect-auto h-56 w-full">
      <BarChart accessibilityLayer data={[...usage.buckets]}>
        <XAxis
          dataKey="start"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          tickFormatter={(value: string) => formatBucket(value, usage.granularity)}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          tickCount={4}
          tickFormatter={formatTokens}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => {
                const bucket = formatBucket(String(label), usage.granularity);
                const requests = requestsByBucket.get(String(label));

                return requests === undefined
                  ? bucket
                  : `${bucket} · ${formatExactTokens(requests)} requests`;
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="inputTokens"
          stackId="a"
          fill="var(--color-inputTokens)"
          isAnimationActive={false}
        />
        <Bar
          dataKey="outputTokens"
          stackId="a"
          fill="var(--color-outputTokens)"
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}
