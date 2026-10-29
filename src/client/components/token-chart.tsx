import { Bar, BarChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyUsage } from "../../shared/analytics";
import { formatDay, formatExactTokens, formatTokens } from "../format";

const chartConfig = {
  inputTokens: { label: "Input", color: "var(--chart-2)" },
  outputTokens: { label: "Output", color: "var(--chart-5)" },
} satisfies ChartConfig;

export function TokenChart({ daily }: { daily: readonly DailyUsage[] }) {
  const requestsByDate = new Map(daily.map((day): [string, number] => [day.date, day.requests]));

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
      <BarChart accessibilityLayer data={[...daily]}>
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          tickFormatter={formatDay}
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
                const date = String(label);
                const requests = requestsByDate.get(date);

                return requests === undefined
                  ? formatDay(date)
                  : `${formatDay(date)} · ${formatExactTokens(requests)} requests`;
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
