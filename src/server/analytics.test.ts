import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { EMPTY_ANALYTICS_FILTERS, type AnalyticsFilters } from "../shared/analytics";
import { tagRefOf } from "../shared/slugs";
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

    const analytics = readAnalytics(db, {
      userId: "user-1",
      days: 30,
      filters: EMPTY_ANALYTICS_FILTERS,
      now: NOW,
    });

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

    const analytics = readAnalytics(db, {
      userId: "user-2",
      days: 30,
      filters: EMPTY_ANALYTICS_FILTERS,
      now: NOW,
    });

    expect(analytics.summary.requests).toBe(1);
  });

  test("returns an empty window without events", () => {
    const db = seeded();

    const analytics = readAnalytics(db, {
      userId: "user-1",
      days: 7,
      filters: EMPTY_ANALYTICS_FILTERS,
      now: NOW,
    });

    expect(analytics.summary.requests).toBe(0);
    expect(analytics.summary.avgTokensPerDay).toBe(0);
    expect(analytics.summary.avgTps).toBeNull();
    expect(analytics.daily).toHaveLength(7);
  });
});

function filters(overrides: Partial<AnalyticsFilters>): AnalyticsFilters {
  return { ...EMPTY_ANALYTICS_FILTERS, ...overrides };
}

function filterSeeded(): DuckDb {
  const db = seeded();

  recordRequest(db, event({}));
  recordRequest(
    db,
    event({
      providerId: "provider-2",
      providerKind: "google",
      model: "smart",
      reference: "smart",
      upstreamModel: "gemini-smart",
      inputTokens: 200,
      outputTokens: 100,
      startedAt: new Date("2026-10-26T09:00:00.000Z"),
    }),
  );
  recordRequest(
    db,
    event({
      reference: tagRefOf("failover"),
      inputTokens: 300,
      outputTokens: 150,
      startedAt: new Date("2026-10-25T09:00:00.000Z"),
    }),
  );
  recordRequest(db, event({ userId: "user-2", inputTokens: 900, outputTokens: 900 }));

  return db;
}

function readFiltered(db: DuckDb, values: Partial<AnalyticsFilters>) {
  return readAnalytics(db, {
    userId: "user-1",
    days: 30,
    filters: filters(values),
    now: NOW,
  });
}

describe("readAnalytics filters", () => {
  test("filters by provider kind", () => {
    const analytics = readFiltered(filterSeeded(), { providerKind: ["google"] });

    expect(analytics.summary.requests).toBe(1);
    expect(analytics.summary.totalTokens).toBe(300);
    expect(analytics.models).toHaveLength(1);
    expect(analytics.models[0]?.model).toBe("smart");
  });

  test("filters by provider account", () => {
    const analytics = readFiltered(filterSeeded(), { providerId: ["provider-1"] });

    expect(analytics.summary.requests).toBe(2);
    expect(analytics.summary.totalTokens).toBe(600);
  });

  test("filters by model alias", () => {
    const analytics = readFiltered(filterSeeded(), { model: ["smart"] });

    expect(analytics.summary.requests).toBe(1);
    expect(analytics.summary.inputTokens).toBe(200);
    expect(analytics.daily.at(-2)?.requests).toBe(1);
  });

  test("filters by tag reference", () => {
    const analytics = readFiltered(filterSeeded(), { tag: ["failover"] });

    expect(analytics.summary.requests).toBe(1);
    expect(analytics.summary.totalTokens).toBe(450);
  });

  test("intersects two dimensions", () => {
    const db = filterSeeded();
    const providerKind = readFiltered(db, { providerKind: ["openai"] });
    const tag = readFiltered(db, { tag: ["failover"] });
    const both = readFiltered(db, { providerKind: ["openai"], tag: ["failover"] });

    expect(providerKind.summary.requests).toBe(2);
    expect(tag.summary.requests).toBe(1);
    expect(both.summary.requests).toBe(1);
    expect(both.summary.totalTokens).toBe(450);
  });

  test("matches any value within one dimension", () => {
    const analytics = readFiltered(filterSeeded(), { providerKind: ["openai", "google"] });

    expect(analytics.summary.requests).toBe(3);
    expect(analytics.summary.totalTokens).toBe(900);
  });

  test("keeps every day when a filter matches nothing", () => {
    const analytics = readFiltered(filterSeeded(), { model: ["absent"] });

    expect(analytics.summary.requests).toBe(0);
    expect(analytics.summary.totalTokens).toBe(0);
    expect(analytics.models).toHaveLength(0);
    expect(analytics.daily).toHaveLength(30);
    expect(analytics.daily.every((day) => day.requests === 0)).toBe(true);
  });

  test("never returns another user's events", () => {
    const analytics = readFiltered(filterSeeded(), { model: ["fast"] });

    expect(analytics.summary.requests).toBe(2);
    expect(analytics.summary.totalTokens).toBe(600);
  });

  test("applies filters to the model breakdown", () => {
    const analytics = readFiltered(filterSeeded(), { tag: ["failover"] });

    expect(analytics.models).toHaveLength(1);
    expect(analytics.models[0]?.model).toBe("fast");
    expect(analytics.models[0]?.requests).toBe(1);
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
