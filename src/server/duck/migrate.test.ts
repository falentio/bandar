import { afterEach, describe, expect, test } from "vite-plus/test";
import { DuckDb, SQL_NULL, sqlBool, sqlInt, sqlReal, sqlText } from "./client";
import { fileURLToPath } from "node:url";

const LIBRARY = fileURLToPath(new URL("../../../vendor/duckdb/libduckdb.so", import.meta.url));

import {
  applyDuckMigrations,
  DuckMigrationDowngradeError,
  DuckMigrationDriftError,
  splitStatements,
  type DuckMigration,
} from "./migrate";

const CREATE = "CREATE TABLE events (id VARCHAR PRIMARY KEY, kind VARCHAR, count BIGINT)";
const init: DuckMigration = { tag: "0001_init", sql: CREATE };

const addIndex: DuckMigration = {
  tag: "0002_index",
  sql: "CREATE INDEX events_kind ON events (kind)",
};

let open: DuckDb[] = [];

function freshDb(): DuckDb {
  const db = new DuckDb(":memory:", LIBRARY);
  open.push(db);

  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("DuckDb", () => {
  test("binds text, integers, reals, booleans and nulls", () => {
    const db = freshDb();
    db.run("CREATE TABLE values_test (s VARCHAR, i BIGINT, r DOUBLE, b BOOLEAN, n VARCHAR)");
    db.run("INSERT INTO values_test VALUES (?, ?, ?, ?, ?)", [
      sqlText("hello"),
      sqlInt(42),
      sqlReal(3.5),
      sqlBool(true),
      SQL_NULL,
    ]);

    expect(db.query("SELECT * FROM values_test")).toEqual([
      { s: "hello", i: "42", r: "3.5", b: "true", n: null },
    ]);
  });

  test("refuses use after close", () => {
    const db = freshDb();
    db.close();

    expect(() => db.query("SELECT 1")).toThrow("closed");
  });
});

describe("applyDuckMigrations", () => {
  test("applies each migration once and reports the current tag", () => {
    const db = freshDb();

    const first = applyDuckMigrations(db, [init, addIndex]);
    expect(first.applied).toEqual(["0001_init", "0002_index"]);
    expect(first.current).toBe("0002_index");

    const second = applyDuckMigrations(db, [init, addIndex]);
    expect(second.applied).toEqual([]);
    expect(second.current).toBe("0002_index");
  });

  test("rolls back a migration that fails, leaving nothing applied", () => {
    const db = freshDb();

    expect(() =>
      applyDuckMigrations(db, [{ tag: "0001_broken", sql: `${CREATE}; SELECT * FROM missing;` }]),
    ).toThrow();

    const ledger = db.query("SELECT count(*) AS n FROM _bandar_duck_migrations");
    expect(ledger[0]?.n).toBe("0");
  });

  test("refuses a changed body for an applied tag", () => {
    const db = freshDb();
    applyDuckMigrations(db, [init]);

    expect(() =>
      applyDuckMigrations(db, [{ tag: "0001_init", sql: `${CREATE} -- edited` }]),
    ).toThrow(DuckMigrationDriftError);
  });

  test("refuses a database holding migrations this build does not embed", () => {
    const db = freshDb();
    applyDuckMigrations(db, [init, addIndex]);

    expect(() => applyDuckMigrations(db, [init])).toThrow(DuckMigrationDowngradeError);
  });
});

describe("splitStatements", () => {
  test("splits on semicolons outside quotes and comments", () => {
    expect(splitStatements("SELECT 1; SELECT ';'; -- a;b\nSELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT ';'",
      "-- a;b\nSELECT 2",
    ]);
  });
});
