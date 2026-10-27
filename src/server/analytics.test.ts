import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { readAnalytics, readRequests } from "./analytics";
import { DuckDb } from "./duck/client";
import { applyDuckMigrations } from "./duck/migrate";
import { recordRequest, type RequestEventInput } from "./router/record";

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

function event(overrides: Partial<RequestEventInput>): RequestEventInput {
  return {
    userId: "user-1",
    apiKeyId: "key-1",
    providerId: "provider-1",
    providerKind: "openai",
    model: "fast",
    reference: "fast",
    upstreamModel: "gpt-fast",
    status: "success",
    httpStatus: 200,
    errorKind: null,
    streamed: true,
    inputTokens: 100,
    outputTokens: 50,
    ttftMs: 200,
    durationMs: 1200,
    inputPricePerMtok: null,
    outputPricePerMtok: null,
    startedAt: new Date("2026-10-27T10:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("readAnalytics", () => {
  test("summarizes the window, fills 30 days and excludes older events", () => {
    const db = seeded();

    recordRequest(db, event({}));
    recordRequest(
      db,
      event({
        model: "smart",
        upstreamModel: "gpt-smart",
        inputTokens: 200,
        outputTokens: 100,
        ttftMs: 400,
        durationMs: 2400,
        startedAt: new Date("2026-10-26T09:00:00.000Z"),
      }),
    );
    recordRequest(
      db,
      event({
        status: "error",
        httpStatus: 502,
        errorKind: "upstream",
        inputTokens: null,
        outputTokens: null,
        ttftMs: null,
        durationMs: 300,
        startedAt: new Date("2026-10-27T11:00:00.000Z"),
      }),
    );
    recordRequest(
      db,
      event({
        inputTokens: 999,
        outputTokens: 999,
        startedAt: new Date("2026-09-20T10:00:00.000Z"),
      }),
    );

    const analytics = readAnalytics(db, { userId: "user-1", days: 30, now: NOW });

    expect(analytics.days).toBe(30);
    expect(analytics.daily).toHaveLength(30);
    expect(analytics.daily[0]?.date).toBe("2026-09-28");
    expect(analytics.daily.at(-1)?.date).toBe("2026-10-27");
    expect(analytics.summary.requests).toBe(3);
    expect(analytics.summary.errors).toBe(1);
    expect(analytics.summary.errorRate).toBe(0.3333);
    expect(analytics.summary.inputTokens).toBe(300);
    expect(analytics.summary.outputTokens).toBe(150);
    expect(analytics.summary.totalTokens).toBe(450);
    expect(analytics.summary.avgTokensPerDay).toBe(15);
    expect(analytics.summary.avgTps).toBe(50);
    expect(analytics.summary.avgTtftMs).toBe(300);
    expect(analytics.summary.p50DurationMs).not.toBeNull();
    expect(analytics.daily.at(-1)?.requests).toBe(2);
    expect(analytics.models).toHaveLength(2);
    expect(analytics.models[0]?.model).toBe("smart");
  });

  test("scopes every metric to one user", () => {
    const db = seeded();
    recordRequest(db, event({}));
    recordRequest(db, event({ userId: "user-2" }));

    const analytics = readAnalytics(db, { userId: "user-2", days: 30, now: NOW });

    expect(analytics.summary.requests).toBe(1);
  });

  test("returns an empty window without events", () => {
    const db = seeded();

    const analytics = readAnalytics(db, { userId: "user-1", days: 7, now: NOW });

    expect(analytics.summary.requests).toBe(0);
    expect(analytics.summary.avgTokensPerDay).toBe(0);
    expect(analytics.summary.avgTps).toBeNull();
    expect(analytics.daily).toHaveLength(7);
  });
});

describe("readRequests", () => {
  test("lists newest first with derived metrics", () => {
    const db = seeded();
    recordRequest(db, event({}));
    recordRequest(
      db,
      event({
        streamed: false,
        ttftMs: null,
        durationMs: 800,
        startedAt: new Date("2026-10-27T11:00:00.000Z"),
      }),
    );

    const list = readRequests(db, { userId: "user-1", limit: 10 });

    expect(list.requests).toHaveLength(2);
    expect(list.requests[0]?.startedAt).toBe("2026-10-27T11:00:00.000Z");
    expect(list.requests[0]?.reference).toBe("fast");
    expect(list.requests[0]?.streamed).toBe(false);
    expect(list.requests[0]?.tokensPerSecond).toBeNull();
    expect(list.requests[1]?.tokensPerSecond).toBe(50);
  });
});
