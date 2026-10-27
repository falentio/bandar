import { isApiPath } from "../shared/api";
import { createApi } from "./api";
import { type ClientBundle, serveStatic } from "./assets";
import type { Db } from "./db/client";
import type { MigrationResult } from "./db/migrate";
import { createNotesRepo } from "./notes";

export type App = { readonly handle: (request: Request) => Promise<Response> };

export type AppDeps = {
  readonly db: Db;
  readonly client: ClientBundle;
  readonly migration: MigrationResult;
};

export function createApp(deps: AppDeps): App {
  const api = createApi(createNotesRepo(deps.db), deps.migration);

  return {
    handle: async (request) => {
      const { pathname } = new URL(request.url);

      if (!isApiPath(pathname)) return serveStatic(request, deps.client);

      return api.handle(request);
    },
  };
}
