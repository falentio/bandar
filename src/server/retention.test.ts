import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { DuckDb, sqlText } from "./duck/client";
import { applyDuckMigrations } from "./duck/migrate";
import {
  DAY_MS,
  pruneRequestLog,
  startHourlyRequestLogPruning,
  type LogRetention,
} from "./retention";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DUCK_DIR = fileURLToPath(new URL("../../duckdb", import.meta.url));

function readDuckMigrations() {
  return readdirSync(DUCK_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      tag: name.slice(0, -4),
      sql: readFileSync(join(DUCK_DIR, name), "utf8"),
    }));
}

let open: DuckDb[] = [];

function seeded(): DuckDb {
  const db = new DuckDb(
    ":memory:",
    fileURLToPath(new URL("../../vendor/duckdb/libduckdb.so", import.meta.url)),
  );

  open.push(db);
  applyDuckMigrations(db, readDuckMigrations());

  return db;
}

function insertEvent(db: DuckDb, id: string, startedAt: Date): void {
  db.run(
    `INSERT INTO request_events (
       id, user_id, provider_id, provider_kind, model, upstream_model, status, streamed, duration_ms, started_at
     ) VALUES (?, 'user-1', 'provider-1', 'openai', 'fast', 'gpt-fast', 'success', true, 1200, ?::TIMESTAMP)`,
    [sqlText(id), sqlText(startedAt.toISOString())],
  );
}

function insertExchange(db: DuckDb, attemptId: string, recordedAt: Date): void {
  db.run(
    `INSERT INTO request_exchanges (
       attempt_id, user_id, downstream_request_id, request_url, request_headers, request_body,
       truncated, recorded_at
     ) VALUES (?, 'user-1', ?, 'https://upstream.test/v1/chat/completions', '{}', '{}', false, ?::TIMESTAMP)`,
    [sqlText(attemptId), sqlText(attemptId), sqlText(recordedAt.toISOString())],
  );
}

const columnOf = (db: DuckDb, sql: string, column: string): string[] =>
  db.query(sql).map((row) => row[column] ?? "");

const eventIds = (db: DuckDb): string[] =>
  columnOf(db, "SELECT id FROM request_events ORDER BY id", "id");

const exchangeIds = (db: DuckDb): string[] =>
  columnOf(db, "SELECT attempt_id FROM request_exchanges ORDER BY attempt_id", "attempt_id");

const fromNow = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

const days = (count: number): LogRetention => ({ kind: "days", days: count });

const FOREVER: LogRetention = { kind: "forever" };

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("pruneRequestLog", () => {
  test("deletes the events and exchanges older than the window, and counts them", () => {
    const db = seeded();

    insertEvent(db, "old-event", fromNow(-9 * DAY_MS));
    insertEvent(db, "recent-event", fromNow(-2 * DAY_MS));
    insertExchange(db, "old-event", fromNow(-9 * DAY_MS));
    insertExchange(db, "recent-event", fromNow(-2 * DAY_MS));

    const pruned = pruneRequestLog(db, days(7), NOW);

    expect(pruned).toEqual({ events: 1, exchanges: 1 });
    expect(eventIds(db)).toEqual(["recent-event"]);
    expect(exchangeIds(db)).toEqual(["recent-event"]);
  });

  test("keeps a row exactly at the cutoff", () => {
    const db = seeded();

    insertEvent(db, "cutoff-event", fromNow(-7 * DAY_MS));
    insertEvent(db, "older-event", fromNow(-7 * DAY_MS - 1));
    insertExchange(db, "cutoff-exchange", fromNow(-7 * DAY_MS));
    insertExchange(db, "older-exchange", fromNow(-7 * DAY_MS - 1));

    const pruned = pruneRequestLog(db, days(7), NOW);

    expect(pruned).toEqual({ events: 1, exchanges: 1 });
    expect(eventIds(db)).toEqual(["cutoff-event"]);
    expect(exchangeIds(db)).toEqual(["cutoff-exchange"]);
  });

  test("a log kept forever keeps every row, however old", () => {
    const db = seeded();

    insertEvent(db, "ancient-event", new Date("2000-01-01T00:00:00.000Z"));
    insertExchange(db, "ancient-event", new Date("2000-01-01T00:00:00.000Z"));

    expect(pruneRequestLog(db, FOREVER, NOW)).toEqual({ events: 0, exchanges: 0 });
    expect(eventIds(db)).toEqual(["ancient-event"]);
    expect(exchangeIds(db)).toEqual(["ancient-event"]);
  });

  test("touches nothing inside the window", () => {
    const db = seeded();

    insertEvent(db, "recent-event", fromNow(-DAY_MS));
    insertExchange(db, "recent-event", fromNow(-DAY_MS));

    expect(pruneRequestLog(db, days(7), NOW)).toEqual({ events: 0, exchanges: 0 });
    expect(eventIds(db)).toEqual(["recent-event"]);
    expect(exchangeIds(db)).toEqual(["recent-event"]);
  });
});

describe("startHourlyRequestLogPruning", () => {
  test("prunes at once and reports the rows it deleted", () => {
    const db = seeded();
    const stale = new Date(Date.now() - 9 * DAY_MS);

    insertEvent(db, "stale-event", stale);
    insertExchange(db, "stale-event", stale);

    const onPruned = vi.fn();

    startHourlyRequestLogPruning(db, days(7), onPruned);

    expect(onPruned).toHaveBeenCalledTimes(1);
    expect(onPruned).toHaveBeenCalledWith({ events: 1, exchanges: 1 });
    expect(eventIds(db)).toEqual([]);
    expect(exchangeIds(db)).toEqual([]);
  });

  test("reports nothing when no row is past the window", () => {
    const db = seeded();

    insertEvent(db, "recent-event", new Date());

    const onPruned = vi.fn();

    startHourlyRequestLogPruning(db, days(7), onPruned);

    expect(onPruned).not.toHaveBeenCalled();
    expect(eventIds(db)).toEqual(["recent-event"]);
  });

  test("a log kept forever is never touched", () => {
    const db = seeded();

    insertEvent(db, "ancient-event", new Date("2000-01-01T00:00:00.000Z"));
    insertExchange(db, "ancient-event", new Date("2000-01-01T00:00:00.000Z"));

    const onPruned = vi.fn();

    startHourlyRequestLogPruning(db, FOREVER, onPruned);

    expect(onPruned).not.toHaveBeenCalled();
    expect(eventIds(db)).toEqual(["ancient-event"]);
    expect(exchangeIds(db)).toEqual(["ancient-event"]);
  });
});
