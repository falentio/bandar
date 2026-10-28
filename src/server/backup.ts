import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { BackupManifestSchema, type BackupManifest, type BackupMember } from "../shared/api";
import { sqlText, type DuckDb } from "./duck/client";
import { version } from "./generated/version";
import { createZip } from "./zip";

export const SQLITE_MEMBER = "bandar.db";
export const DUCKDB_MEMBER = "bandar.duckdb";
export const MANIFEST_MEMBER = "manifest.json";

export type BackupSource = {
  readonly sqlite: Database;
  readonly duck: DuckDb;
  readonly sqliteTag: string | null;
  readonly duckdbTag: string | null;
};

export type BackupArchive = {
  readonly name: string;
  readonly bytes: Uint8Array;
};

export function backupFileName(at: Date): string {
  return `bandar-backup-${version}-${timestamp(at)}.zip`;
}

/**
 * Both stores are snapshotted through the live handles in this process. A file copy
 * of a WAL database, SQLite or DuckDB, can miss committed pages that still sit in
 * the write-ahead log.
 */
export async function createBackup(
  source: BackupSource,
  at: Date = new Date(),
): Promise<BackupArchive> {
  const work = mkdtempSync(join(tmpdir(), "bandar-backup-"));

  try {
    const snapshot = join(work, SQLITE_MEMBER);
    const analytics = join(work, DUCKDB_MEMBER);

    source.sqlite.run("VACUUM INTO ?", [snapshot]);
    exportAnalytics(source.duck, analytics);

    const sqliteBytes = new Uint8Array(await Bun.file(snapshot).arrayBuffer());
    const duckdbBytes = new Uint8Array(await Bun.file(analytics).arrayBuffer());

    const manifest = v.parse(BackupManifestSchema, {
      version,
      createdAt: at.toISOString(),
      sqliteTag: source.sqliteTag,
      duckdbTag: source.duckdbTag,
      members: [member(SQLITE_MEMBER, sqliteBytes), member(DUCKDB_MEMBER, duckdbBytes)],
    });

    const bytes = createZip(
      [
        { name: SQLITE_MEMBER, data: sqliteBytes, method: "deflate" },
        { name: DUCKDB_MEMBER, data: duckdbBytes, method: "deflate" },
        { name: MANIFEST_MEMBER, data: encode(manifest), method: "deflate" },
      ],
      at,
    );

    return { name: backupFileName(at), bytes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function encode(manifest: BackupManifest): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

const SNAPSHOT = "bandar_snapshot";

/**
 * DuckDB holds its file open for the life of the instance, and Windows refuses a
 * second handle on it, so the analytics copy is made by DuckDB itself: attach a
 * fresh file and copy the catalog into it. The copy reads through MVCC, so a
 * concurrent transaction neither blocks it nor lands in it.
 */
function exportAnalytics(duck: DuckDb, target: string): void {
  const catalog = currentCatalog(duck);

  duck.run("CHECKPOINT");
  duck.run(`ATTACH ? AS ${SNAPSHOT}`, [sqlText(target)]);

  try {
    duck.run(`COPY FROM DATABASE ${identifier(catalog)} TO ${SNAPSHOT}`);
  } finally {
    duck.run(`DETACH ${SNAPSHOT}`);
  }
}

function currentCatalog(duck: DuckDb): string {
  const row = duck.query("SELECT current_database() AS name")[0];

  if (row?.name === null || row?.name === undefined)
    throw new Error("DuckDB did not report its own catalog name");

  return row.name;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function member(name: string, data: Uint8Array): BackupMember {
  return {
    name,
    size: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function timestamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;
}
