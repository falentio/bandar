import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema>;

export type DatabaseHandle = { readonly sqlite: Database; readonly db: Db };

export function openDatabase(path: string): DatabaseHandle {
  const sqlite = new Database(path, { create: true });

  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");

  return { sqlite, db: drizzle(sqlite, { schema }) };
}
