const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const whole = new Intl.NumberFormat("en");

export function formatTokens(value: number | null): string {
  if (value === null) return "—";

  return compact.format(value);
}

export function formatExactTokens(value: number | null): string {
  return value === null ? "—" : whole.format(value);
}

export function formatTps(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} tok/s`;
}

export function formatMs(value: number | null): string {
  if (value === null) return "—";

  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";

  return value === 0 ? "$0" : `$${value.toFixed(4)}`;
}

export function formatWhen(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
