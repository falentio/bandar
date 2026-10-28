import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BackupManifestSchema } from "../shared/api";
import {
  DUCKDB_MEMBER,
  MANIFEST_MEMBER,
  SQLITE_MEMBER,
  backupFileName,
  createBackup,
} from "./backup";
import { DuckDb } from "./duck/client";
import { version } from "./generated/version";

const AT = new Date("2026-01-02T03:04:05Z");

const LIBRARY_NAME =
  process.platform === "darwin"
    ? "libduckdb.dylib"
    : process.platform === "win32"
      ? "duckdb.dll"
      : "libduckdb.so";

const LIBRARY = fileURLToPath(new URL(`../../vendor/duckdb/${LIBRARY_NAME}`, import.meta.url));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();

  cleanups.length = 0;
});

type Member = { readonly name: string; readonly data: Uint8Array };

/** Read the local headers only, the way an extractor walks them front to back. */
function membersOf(bytes: Uint8Array): readonly Member[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(bytes.byteLength - 12, true);
  const members: Member[] = [];
  let offset = 0;

  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x04034b50);

    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const payload = bytes.subarray(start, start + compressed);

    members.push({ name, data: method === 8 ? new Uint8Array(inflateRawSync(payload)) : payload });
    offset = start + compressed;
  }

  return members;
}

function member(members: readonly Member[], name: string): Uint8Array {
  const found = members.find((entry) => entry.name === name);

  if (found === undefined) throw new Error(`${name} is not in the archive`);

  return found.data;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "backup-test-"));

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function sqliteFixture(dir: string): Database {
  const sqlite = new Database(join(dir, "live.db"), { create: true });

  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("CREATE TABLE providers (id TEXT PRIMARY KEY)");
  sqlite.exec("INSERT INTO providers (id) VALUES ('p1')");
  cleanups.push(() => sqlite.close());

  return sqlite;
}

function duckFixture(dir: string): DuckDb {
  const duck = new DuckDb(join(dir, "live.duckdb"), LIBRARY);

  duck.run("CREATE TABLE requests (id VARCHAR PRIMARY KEY)");
  duck.run("INSERT INTO requests VALUES ('r1')");
  cleanups.push(() => duck.close());

  return duck;
}

function copyTo(dir: string, name: string, bytes: Uint8Array): string {
  const path = join(dir, name);

  writeFileSync(path, bytes);

  return path;
}

function tempCopies(): readonly string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("bandar-backup-"));
}

describe("createBackup", () => {
  test("writes the sqlite snapshot, the duckdb snapshot, and the manifest in order", async () => {
    const dir = workDir();

    const archive = await createBackup(
      {
        sqlite: sqliteFixture(dir),
        duck: duckFixture(dir),
        sqliteTag: "0001_init",
        duckdbTag: "0002_request_reference",
      },
      AT,
    );

    expect(archive.name).toBe(`bandar-backup-${version}-20260102T030405Z.zip`);
    expect(membersOf(archive.bytes).map((entry) => entry.name)).toEqual([
      SQLITE_MEMBER,
      DUCKDB_MEMBER,
      MANIFEST_MEMBER,
    ]);
  });

  test("the manifest reports the version, the tags, and a digest per member", async () => {
    const dir = workDir();
    const sqlite = sqliteFixture(dir);

    const archive = await createBackup(
      {
        sqlite,
        duck: duckFixture(dir),
        sqliteTag: "0001_init",
        duckdbTag: "0002_request_reference",
      },
      AT,
    );

    const members = membersOf(archive.bytes);

    const manifest = v.parse(
      BackupManifestSchema,
      JSON.parse(decode(member(members, MANIFEST_MEMBER))),
    );

    expect(manifest.version).toBe(version);
    expect(manifest.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(manifest.sqliteTag).toBe("0001_init");
    expect(manifest.duckdbTag).toBe("0002_request_reference");
    expect(manifest.members.map((entry) => entry.name)).toEqual([SQLITE_MEMBER, DUCKDB_MEMBER]);

    for (const recorded of manifest.members) {
      const data = member(members, recorded.name);

      expect(recorded.size).toBe(data.byteLength);
      expect(recorded.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });

  test("the sqlite member is a snapshot taken through the write-ahead log", async () => {
    const dir = workDir();
    const sqlite = sqliteFixture(dir);
    const live = join(dir, "live.db");

    expect(statSync(`${live}-wal`).size).toBeGreaterThan(0);

    const members = membersOf(
      (await createBackup({ sqlite, duck: duckFixture(dir), sqliteTag: null, duckdbTag: null }))
        .bytes,
    );

    const snapshot = new Database(copyTo(dir, "snapshot.db", member(members, SQLITE_MEMBER)));

    try {
      expect(snapshot.query<{ id: string }, []>("SELECT id FROM providers").all()).toEqual([
        { id: "p1" },
      ]);
    } finally {
      snapshot.close();
    }

    // The live file still holds the row only in its WAL, so a plain copy would lose it.
    expect(statSync(`${live}-wal`).size).toBeGreaterThan(0);
  });

  test("the duckdb member is a complete export of the live catalog", async () => {
    const dir = workDir();
    const duck = duckFixture(dir);

    const members = membersOf(
      (await createBackup({ sqlite: sqliteFixture(dir), duck, sqliteTag: null, duckdbTag: null }))
        .bytes,
    );

    const copy = new DuckDb(
      copyTo(dir, "snapshot.duckdb", member(members, DUCKDB_MEMBER)),
      LIBRARY,
    );

    try {
      expect(copy.query("SELECT id FROM requests")).toEqual([{ id: "r1" }]);
      expect(() => copy.run("INSERT INTO requests VALUES ('r1')")).toThrow(/constraint/iu);
    } finally {
      copy.close();
    }

    expect(existsSync(`${duck.path}.wal`)).toBe(false);
  });

  test("exports a consistent snapshot while another connection holds a write", async () => {
    const dir = workDir();
    const duck = duckFixture(dir);
    const writer = new DuckDb(join(dir, "live.duckdb"), LIBRARY);

    cleanups.push(() => writer.close());
    writer.run("BEGIN");
    writer.run("INSERT INTO requests VALUES ('r2')");

    const members = membersOf(
      (await createBackup({ sqlite: sqliteFixture(dir), duck, sqliteTag: null, duckdbTag: null }))
        .bytes,
    );

    const copy = new DuckDb(
      copyTo(dir, "snapshot.duckdb", member(members, DUCKDB_MEMBER)),
      LIBRARY,
    );

    try {
      expect(copy.query("SELECT id FROM requests")).toEqual([{ id: "r1" }]);
    } finally {
      copy.close();
      writer.run("ROLLBACK");
    }
  });

  test("removes the temporary copies on both exits", async () => {
    const before = tempCopies();
    const dir = workDir();
    const sqlite = sqliteFixture(dir);
    const duck = duckFixture(dir);

    await createBackup({ sqlite, duck, sqliteTag: null, duckdbTag: null });

    expect(tempCopies()).toEqual(before);

    duck.close();
    await expect(createBackup({ sqlite, duck, sqliteTag: null, duckdbTag: null })).rejects.toThrow(
      /closed/u,
    );
    expect(tempCopies()).toEqual(before);
  });
});

describe("backupFileName", () => {
  test("stamps the version and the UTC time", () => {
    expect(backupFileName(AT)).toBe(`bandar-backup-${version}-20260102T030405Z.zip`);
  });
});
