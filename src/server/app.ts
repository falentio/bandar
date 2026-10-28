import type { Database } from "bun:sqlite";
import { isApiPath, isGatewayPath } from "../shared/api";
import { createApi } from "./api";
import { type ClientBundle, serveStatic } from "./assets";
import type { Auth } from "./auth";
import type { Db } from "./db/client";
import type { MigrationResult } from "./db/migrate";
import type { DuckDb } from "./duck/client";
import type { DuckMigrationResult } from "./duck/migrate";
import { createGateway } from "./gateway";
import type { Sealer } from "./seal";

export type App = { readonly handle: (request: Request) => Promise<Response> };

export type AppDeps = {
  readonly db: Db;
  readonly sqlite: Database;
  readonly client: ClientBundle;
  readonly migration: MigrationResult;
  readonly duckMigration: DuckMigrationResult;
  readonly auth: Auth;
  readonly duck: DuckDb;
  readonly sealer: Sealer;
};

export function createApp(deps: AppDeps): App {
  const providers = { db: deps.db, sealer: deps.sealer };

  const api = createApi({
    auth: deps.auth,
    duck: deps.duck,
    sqlite: deps.sqlite,
    providers,
    migration: deps.migration,
    duckMigration: deps.duckMigration,
  });

  const gateway = createGateway({ auth: deps.auth, duck: deps.duck, providers });

  // Both plugins must be compiled before the first request. Elysia rebuilds the router of a
  // served plugin when another root plugin is created, and that rebuild drops late routes.
  api.compile();
  gateway.compile();

  return {
    handle: async (request) => {
      const { pathname } = new URL(request.url);

      if (isGatewayPath(pathname)) return gateway.handle(request);

      if (!isApiPath(pathname)) return serveStatic(request, deps.client);

      return api.handle(request);
    },
  };
}
