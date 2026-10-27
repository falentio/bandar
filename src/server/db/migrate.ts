import type { Database } from "bun:sqlite";

export type Migration = { readonly tag: string; readonly sql: string };

export type MigrationResult = {
  readonly applied: readonly string[];
  readonly current: string | null;
};

export class MigrationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDriftError";
  }
}

export class MigrationDowngradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDowngradeError";
  }
}

const LEDGER = "_bandar_migrations";

type LedgerRow = { readonly tag: string; readonly checksum: string };

export function applyMigrations(
  sqlite: Database,
  migrations: readonly Migration[],
): MigrationResult {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (tag TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );

  const applied = new Map(
    sqlite
      .query<LedgerRow, []>(`SELECT tag, checksum FROM ${LEDGER}`)
      .all()
      .map((row) => [row.tag, row.checksum]),
  );

  assertSameRelease(applied, migrations);

  const executed: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue;

    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(migration.sql);
      sqlite
        .query(`INSERT INTO ${LEDGER} (tag, checksum, applied_at) VALUES (?, ?, ?)`)
        .run(migration.tag, checksumOf(migration.sql), Date.now());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    executed.push(migration.tag);
  }

  const now = new Set([...applied.keys(), ...executed]);
  const current =
    [...migrations].reverse().find((migration) => now.has(migration.tag))?.tag ?? null;

  return { applied: executed, current };
}

function assertSameRelease(
  applied: ReadonlyMap<string, string>,
  migrations: readonly Migration[],
): void {
  const embedded = new Set(migrations.map((migration) => migration.tag));

  const missing = [...applied.keys()].filter((tag) => !embedded.has(tag));
  if (missing.length > 0) {
    throw new MigrationDowngradeError(
      `database has migrations this binary does not embed: ${missing.join(", ")}. Start a newer build.`,
    );
  }

  const drifted = migrations.filter((migration) => {
    const stored = applied.get(migration.tag);
    return stored !== undefined && stored !== checksumOf(migration.sql);
  });
  if (drifted.length > 0) {
    throw new MigrationDriftError(
      `applied migrations changed body: ${drifted.map((migration) => migration.tag).join(", ")}. ` +
        "Revert the edit and add a new migration instead.",
    );
  }
}

function checksumOf(sql: string): string {
  return Bun.hash.crc32(sql).toString(16);
}
