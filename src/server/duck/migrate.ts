import { sqlText, type DuckDb } from "./client";

export type DuckMigration = { readonly tag: string; readonly sql: string };

export type DuckMigrationResult = {
  readonly applied: readonly string[];
  readonly current: string | null;
};

export class DuckMigrationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuckMigrationDriftError";
  }
}

export class DuckMigrationDowngradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuckMigrationDowngradeError";
  }
}

const LEDGER = "_bandar_duck_migrations";

export function applyDuckMigrations(
  db: DuckDb,
  migrations: readonly DuckMigration[],
): DuckMigrationResult {
  db.run(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (tag VARCHAR PRIMARY KEY, checksum VARCHAR NOT NULL, applied_at TIMESTAMP NOT NULL)`,
  );

  const applied = new Map<string, string>();

  for (const row of db.query(`SELECT tag, checksum FROM ${LEDGER}`)) {
    const tag = row.tag;
    const checksum = row.checksum;

    if (tag !== null && tag !== undefined && checksum !== null && checksum !== undefined) {
      applied.set(tag, checksum);
    }
  }

  assertSameRelease(applied, migrations);

  const executed: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue;

    db.run("BEGIN");

    try {
      for (const statement of splitStatements(migration.sql)) db.run(statement);

      db.run(`INSERT INTO ${LEDGER} (tag, checksum, applied_at) VALUES (?, ?, ?::TIMESTAMP)`, [
        sqlText(migration.tag),
        sqlText(checksumOf(migration.sql)),
        sqlText(new Date().toISOString()),
      ]);
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    executed.push(migration.tag);
  }

  const now = new Set([...applied.keys(), ...executed]);

  const current =
    [...migrations].reverse().find((migration) => now.has(migration.tag))?.tag ?? null;

  return { applied: executed, current };
}

export function splitStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let comment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (comment) {
      current += character;

      if (character === "\n") comment = false;

      continue;
    }

    if (quote !== null) {
      current += character;

      if (character === quote) quote = null;

      continue;
    }

    if (character === "-" && next === "-") {
      comment = true;
      current += character;

      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      current += character;

      continue;
    }

    if (character === ";") {
      pushStatement(statements, current);
      current = "";

      continue;
    }

    current += character;
  }

  pushStatement(statements, current);

  return statements;
}

function pushStatement(statements: string[], statement: string): void {
  const trimmed = statement.trim();

  if (trimmed !== "") statements.push(trimmed);
}

function assertSameRelease(
  applied: ReadonlyMap<string, string>,
  migrations: readonly DuckMigration[],
): void {
  const embedded = new Set(migrations.map((migration) => migration.tag));
  const missing = [...applied.keys()].filter((tag) => !embedded.has(tag));

  if (missing.length > 0) {
    throw new DuckMigrationDowngradeError(
      `analytics database has migrations this binary does not embed: ${missing.join(", ")}. Start a newer build.`,
    );
  }

  const drifted = migrations.filter((migration) => {
    const stored = applied.get(migration.tag);

    return stored !== undefined && stored !== checksumOf(migration.sql);
  });

  if (drifted.length > 0) {
    throw new DuckMigrationDriftError(
      `applied DuckDB migrations changed body: ${drifted.map((migration) => migration.tag).join(", ")}. ` +
        "Revert the edit and add a new migration instead.",
    );
  }
}

function checksumOf(sql: string): string {
  return Bun.hash.crc32(sql).toString(16);
}
