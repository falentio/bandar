import type { DuckDb } from "./duck/client";
import { sqlText } from "./duck/client";

/** The log keeps a window of whole days, or everything it ever wrote. */
export type LogRetention =
  | { readonly kind: "days"; readonly days: number }
  | { readonly kind: "forever" };

export type PrunedRequests = {
  readonly events: number;
  readonly exchanges: number;
};

export const DAY_MS = 86_400_000;

const HOURLY_MS = 3_600_000;

type PruneStatements = { readonly stale: string; readonly prune: string };

const EXCHANGES: PruneStatements = {
  stale: "SELECT count(*) AS rows FROM request_exchanges WHERE recorded_at < ?::TIMESTAMP",
  prune: "DELETE FROM request_exchanges WHERE recorded_at < ?::TIMESTAMP",
};

const EVENTS: PruneStatements = {
  stale: "SELECT count(*) AS rows FROM request_events WHERE started_at < ?::TIMESTAMP",
  prune: "DELETE FROM request_events WHERE started_at < ?::TIMESTAMP",
};

export function pruneRequestLog(
  db: DuckDb,
  retention: LogRetention,
  now: Date = new Date(),
): PrunedRequests {
  if (retention.kind === "forever") return { events: 0, exchanges: 0 };

  const cutoff = new Date(now.getTime() - retention.days * DAY_MS).toISOString();

  return {
    exchanges: pruneOlder(db, EXCHANGES, cutoff),
    events: pruneOlder(db, EVENTS, cutoff),
  };
}

export function startHourlyRequestLogPruning(
  db: DuckDb,
  retention: LogRetention,
  onPruned: (pruned: PrunedRequests) => void,
): void {
  const run = (): void => {
    const pruned = pruneRequestLog(db, retention);

    if (pruned.events + pruned.exchanges > 0) onPruned(pruned);
  };

  run();

  if (retention.kind === "days") setInterval(run, HOURLY_MS).unref();
}

function pruneOlder(db: DuckDb, statements: PruneStatements, cutoff: string): number {
  const [counted] = db.query(statements.stale, [sqlText(cutoff)]);

  db.run(statements.prune, [sqlText(cutoff)]);

  return Number(counted?.rows ?? 0);
}
