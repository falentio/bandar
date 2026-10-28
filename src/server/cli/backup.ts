import { Database } from "bun:sqlite";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBackup } from "../backup";
import { parseConfig } from "../config";
import { DuckDb } from "../duck/client";
import type { Commands, Env } from "./command";

export function register(commands: Commands): void {
  commands.add({
    name: "backup",
    summary: "write a zip holding both databases and a manifest",
    takesArguments: true,
    run: backup,
  });
}

type BackupArgs =
  | { readonly kind: "ok"; readonly out: string | null }
  | { readonly kind: "invalid"; readonly message: string };

export function parseBackupArgs(args: readonly string[]): BackupArgs {
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--out") {
      const value = args[index + 1];

      if (value === undefined) return { kind: "invalid", message: "--out needs a path" };

      out = value;
      index += 1;

      continue;
    }

    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);

      if (value === "") return { kind: "invalid", message: "--out needs a path" };

      out = value;

      continue;
    }

    return { kind: "invalid", message: `unknown option: ${arg}` };
  }

  return { kind: "ok", out };
}

async function backup(env: Env, args: readonly string[]): Promise<number> {
  const parsed = parseBackupArgs(args);

  if (parsed.kind === "invalid") {
    console.error(`bandar backup: ${parsed.message}`);

    return 2;
  }

  try {
    const config = parseConfig(env);

    requireDatabase(config.databasePath, "SQLite");
    requireDatabase(config.duckdbPath, "DuckDB");

    const sqlite = new Database(config.databasePath, { readonly: true });
    // Imported here, not at module load: the embedded library is a build artifact that
    // only this command and serve reach, and every CLI test imports this module.
    const { embeddedDuckLibrary } = await import("../duck/embedded");

    // Only a write connection can fold DuckDB's write-ahead log back into the file; a
    // server still holding this database refuses the open, which is what a backup wants.
    const duck = new DuckDb(config.duckdbPath, embeddedDuckLibrary);

    try {
      const archive = await createBackup({
        sqlite,
        duck,
        sqliteTag: sqliteTag(sqlite),
        duckdbTag: duckdbTag(duck),
      });

      const target = outputPath(parsed.out, archive.name);

      writeFileSync(target, archive.bytes);
      console.log(target);

      return 0;
    } finally {
      duck.close();
      sqlite.close();
    }
  } catch (error) {
    console.error(`bandar backup: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
}

function requireDatabase(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`no ${label} database at ${path}`);
}

function outputPath(out: string | null, name: string): string {
  if (out === null) return resolve(name);

  return existsSync(out) && statSync(out).isDirectory() ? join(out, name) : resolve(out);
}

function sqliteTag(sqlite: Database): string | null {
  try {
    const row = sqlite
      .query<{ tag: string }, []>(
        "SELECT tag FROM _bandar_migrations ORDER BY applied_at DESC, rowid DESC LIMIT 1",
      )
      .get();

    return row?.tag ?? null;
  } catch {
    // A database bandar never booted has no ledger to read a tag from.
    return null;
  }
}

function duckdbTag(duck: DuckDb): string | null {
  try {
    const rows = duck.query(
      "SELECT tag FROM _bandar_duck_migrations ORDER BY applied_at DESC LIMIT 1",
    );

    return rows[0]?.tag ?? null;
  } catch {
    // A database bandar never booted has no ledger to read a tag from.
    return null;
  }
}
