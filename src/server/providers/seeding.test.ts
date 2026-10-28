import { Database } from "bun:sqlite";
import { BUILT_IN_PROVIDER_KINDS } from "../../shared/providers";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { openDatabase } from "../db/client";
import { applyMigrations, type Migration } from "../db/migrate";
import { createSealer } from "../seal";
import { listProviders, type ProviderDeps } from ".";

const DRIZZLE = fileURLToPath(new URL("../../../drizzle", import.meta.url));

let open: Database[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

async function freshDb(): Promise<{ readonly sqlite: Database; readonly deps: ProviderDeps }> {
  const { sqlite, db } = openDatabase(":memory:");

  open.push(sqlite);
  // The fixture inserts provider rows for a user it never creates.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  applyMigrations(sqlite, migrationsFromDisk());

  return { sqlite, deps: { db, sealer: await createSealer("seeding-test") } };
}

function migrationsFromDisk(): readonly Migration[] {
  return readdirSync(DRIZZLE)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ tag: name.slice(0, -4), sql: readFileSync(join(DRIZZLE, name), "utf8") }));
}

function insertCustomProvider(sqlite: Database, name: string, slug: string): void {
  sqlite
    .query(
      `INSERT INTO providers (id, user_id, name, slug, kind, base_url, origin, created_at)
       VALUES ('custom-1', 'user-1', ?, ?, 'openai', 'https://example.test/v1', 'custom', ?)`,
    )
    .run(name, slug, Date.now());
}

describe("built-in seeding", () => {
  test("a custom provider holding a now-reserved slug does not suppress the built-in", async () => {
    const { sqlite, deps } = await freshDb();

    insertCustomProvider(sqlite, "Nous Portal", "nous");

    const list = await listProviders(deps, "user-1");
    const nous = list.providers.find((provider) => provider.kind === "nous");
    const custom = list.providers.find((provider) => provider.id === "custom-1");

    expect(nous?.origin).toBe("builtin");
    expect(nous?.name).toBe("Nous Portal 2");
    expect(nous?.slug).toBe("nous-2");
    expect(custom?.slug).toBe("nous");
  });

  test("a built-in seeded later keeps its registry position", async () => {
    const { sqlite, deps } = await freshDb();
    const expected = [...BUILT_IN_PROVIDER_KINDS];

    const kinds = async (userId: string) =>
      (await listProviders(deps, userId)).providers
        .filter((provider) => provider.origin === "builtin")
        .map((provider) => provider.kind);

    expect(await kinds("user-3")).toEqual(expected);

    sqlite.query("DELETE FROM providers WHERE user_id = 'user-3' AND kind = 'tokenharbor'").run();

    expect(await kinds("user-3")).toEqual(expected);
  });

  test("seeding on every read adds no second row", async () => {
    const { deps } = await freshDb();

    const first = await listProviders(deps, "user-2");
    const second = await listProviders(deps, "user-2");

    expect(second.providers).toHaveLength(first.providers.length);
    expect(new Set(second.providers.map((provider) => provider.slug)).size).toBe(
      second.providers.length,
    );
  });
});
