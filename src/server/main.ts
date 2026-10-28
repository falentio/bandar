import { createApp } from "./app";
import { createClientBundle } from "./assets";
import { createAuth } from "./auth";
import { parseArgs } from "./cli/args";
import type { Env } from "./cli/command";
import { createCli, renderUsage } from "./cli/registry";
import { loadConfig, warnIfAuthSecretUnset } from "./config";
import { openDatabase } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { DuckDb } from "./duck/client";
import { embeddedDuckLibrary } from "./duck/embedded";
import { applyDuckMigrations } from "./duck/migrate";
import { duckMigrations } from "./generated/duck-migrations";
import { clientFiles } from "./generated/client-assets";
import { migrations } from "./generated/migrations";
import { version } from "./generated/version";
import { assignProviderSlugs } from "./providers/seeding";
import { createSealer } from "./seal";
import { settingsIo } from "./settings-io";

export async function main(env: Env, argv: readonly string[]): Promise<number> {
  const cli = createCli(startServer);
  const invocation = parseArgs(argv, cli);

  switch (invocation.kind) {
    case "help":
      console.log(renderUsage(cli));

      return 0;
    case "version":
      console.log(version);

      return 0;
    case "invalid":
      console.error(`bandar: ${invocation.message}`);
      console.error(renderUsage(cli));

      return 2;
    case "command":
      return invocation.command.run(env, invocation.args ?? []);
  }
}

async function startServer(env: Env): Promise<void> {
  warnIfAuthSecretUnset(env);

  const config = loadConfig(env, settingsIo);

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

  const app = createApp({
    db,
    sqlite,
    duck,
    sealer,
    client,
    migration,
    duckMigration,
    auth,
    endpoints: config.providers,
  });

  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.handle });

  console.log(
    `bandar: listening on ${String(server.url)} (sqlite: ${migration.applied.length} applied, ` +
      `${migration.current ?? "none"}; duckdb: ${duckMigration.applied.length} applied, ` +
      `${duckMigration.current ?? "none"}; client: ${client.kind})`,
  );
}

process.exitCode = await main(Bun.env, Bun.argv.slice(2));
