import { createApp } from "./app";
import { createClientBundle } from "./assets";
import { createAuth } from "./auth";
import { parseConfig } from "./config";
import { openDatabase } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { clientFiles } from "./generated/client-assets";
import { migrations } from "./generated/migrations";

export async function main(env: Record<string, string | undefined>): Promise<void> {
  const config = parseConfig(env);

  const { sqlite, db } = openDatabase(config.databasePath);
  const migration = applyMigrations(sqlite, migrations);
  const client = createClientBundle(clientFiles);
  const auth = createAuth(db, config);

  const app = createApp({ db, client, migration, auth });
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.handle });

  console.log(
    `bandar: listening on ${String(server.url)} (migrations: ${migration.applied.length} applied, ` +
      `current ${migration.current ?? "none"}, client: ${client.kind})`,
  );
}

await main(Bun.env);
