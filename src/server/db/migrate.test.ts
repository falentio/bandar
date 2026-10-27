import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  MigrationDowngradeError,
  MigrationDriftError,
  type Migration,
} from "./migrate";

const CREATE = "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)";

const init: Migration = { tag: "0000_init", sql: CREATE };
const addIndex: Migration = { tag: "0001_index", sql: "CREATE INDEX notes_body ON notes (body)" };

let open: Database[] = [];

function freshDb(): Database {
  const db = new Database(":memory:");
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("applyMigrations", () => {
  test("applies each migration once and reports the current tag", () => {
    const db = freshDb();

    const first = applyMigrations(db, [init, addIndex]);
    expect(first.applied).toEqual(["0000_init", "0001_index"]);
    expect(first.current).toBe("0001_index");

    const second = applyMigrations(db, [init, addIndex]);
    expect(second.applied).toEqual([]);
    expect(second.current).toBe("0001_index");

    const rows = db.query<{ count: number }, []>("SELECT count(*) AS count FROM notes").get();
    expect(rows?.count).toBe(0);
  });

  test("rolls back a migration that throws, leaving nothing applied", () => {
    const db = freshDb();
    const broken: Migration = {
      tag: "0000_broken",
      sql: `${CREATE}; INSERT INTO missing VALUES (1);`,
    };

    expect(() => applyMigrations(db, [broken])).toThrow();

    const ledger = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM _bandar_migrations")
      .get();
    expect(ledger?.count).toBe(0);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
      )
      .all();
    expect(tables).toEqual([]);
  });

  test("refuses a changed body for an applied tag", () => {
    const db = freshDb();
    applyMigrations(db, [init]);

    expect(() => applyMigrations(db, [{ tag: "0000_init", sql: `${CREATE} -- edited` }])).toThrow(
      MigrationDriftError,
    );
  });

  test("refuses a database holding migrations this build does not embed", () => {
    const db = freshDb();
    applyMigrations(db, [init, addIndex]);

    expect(() => applyMigrations(db, [init])).toThrow(MigrationDowngradeError);
  });
});
