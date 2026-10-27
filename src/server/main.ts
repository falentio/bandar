import { createApp } from "./app";
import { createClientBundle } from "./assets";
import { createAuth } from "./auth";
import { parseConfig } from "./config";
import { openDatabase } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { DuckDb } from "./duck/client";
import { embeddedDuckLibrary } from "./duck/embedded";
import { applyDuckMigrations } from "./duck/migrate";
import { duckMigrations } from "./generated/duck-migrations";
import { clientFiles } from "./generated/client-assets";
import { migrations } from "./generated/migrations";
import { assignProviderSlugs } from "./providers";
import { createSealer } from "./seal";

export async function main(env: Record<string, string | undefined>): Promise<void> {
  const config = parseConfig(env);

  const { sqlite, db } = openDatabase(config.databasePath);
  const migration = applyMigrations(sqlite, migrations);
  const assignedSlugs = await assignProviderSlugs(db);

  if (assignedSlugs > 0) {
    console.log(`bandar: assigned ${String(assignedSlugs)} provider slug(s)`);
  }

  const duck = new DuckDb(config.duckdbPath, embeddedDuckLibrary);
  const duckMigration = applyDuckMigrations(duck, duckMigrations);

  const client = createClientBundle(clientFiles);
  const auth = createAuth(db, config);
  const sealer = await createSealer(config.authSecret);

  const app = createApp({ db, duck, sealer, client, migration, duckMigration, auth });
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.handle });

  console.log(
    `bandar: listening on ${String(server.url)} (sqlite: ${migration.applied.length} applied, ` +
      `${migration.current ?? "none"}; duckdb: ${duckMigration.applied.length} applied, ` +
      `${duckMigration.current ?? "none"}; client: ${client.kind})`,
  );
}

await main(Bun.env);
