import { formatWhen } from "../format";

export type HealthFields = {
  readonly failures: number;
  readonly flaggedUntil: string | null;
};

export function HealthBadge(health: HealthFields) {
  if (health.flaggedUntil !== null && new Date(health.flaggedUntil).getTime() > Date.now()) {
    return (
      <span className="text-xs text-destructive">
        cooling down until {formatWhen(health.flaggedUntil)}
      </span>
    );
  }

  if (health.failures === 0) return null;

  return <span className="text-xs text-muted-foreground">recovered</span>;
}
