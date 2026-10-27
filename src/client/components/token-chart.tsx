import type { DailyUsage } from "../../shared/analytics";
import { formatDay, formatExactTokens } from "../format";

export function TokenChart({ daily }: { daily: readonly DailyUsage[] }) {
  const max = Math.max(...daily.map((day) => day.inputTokens + day.outputTokens), 1);
  const first = daily[0];
  const last = daily.at(-1);

  return (
    <div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary/40" /> input
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary" /> output
        </span>
      </div>
      <div className="mt-3 flex h-40 items-end gap-[2px]">
        {daily.map((day) => (
          <div
            key={day.date}
            className="flex h-full flex-1 flex-col justify-end"
            title={`${day.date}: ${formatExactTokens(day.inputTokens)} in, ${formatExactTokens(
              day.outputTokens,
            )} out, ${day.requests} requests`}
          >
            <div
              className="w-full bg-primary"
              style={{ height: `${(day.outputTokens / max) * 100}%` }}
            />
            <div
              className="w-full bg-primary/40"
              style={{ height: `${(day.inputTokens / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{first === undefined ? "" : formatDay(first.date)}</span>
        <span>{last === undefined ? "" : formatDay(last.date)}</span>
      </div>
    </div>
  );
}
