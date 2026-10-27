import { Elysia } from "elysia";
import * as v from "valibot";
import { AnalyticsSchema, RequestListSchema } from "../shared/analytics";
import { HealthSchema, type ApiErrorBody, type Health } from "../shared/api";
import { API_KEY_HEADER } from "../shared/api-keys";
import {
  ProviderInputSchema,
  ProviderModelInputSchema,
  ProviderModelParamsSchema,
  ProviderParamsSchema,
} from "../shared/providers";
import { readAnalytics, readRequests } from "./analytics";
import type { Auth, SessionUser } from "./auth";
import type { MigrationResult } from "./db/migrate";
import type { DuckDb } from "./duck/client";
import {
  addProviderModel,
  createProvider,
  listProviders,
  removeProvider,
  removeProviderModel,
  updateProvider,
  type ProviderDeps,
} from "./providers";
import { InputError, parseInput, type ParseableInput } from "./validation";

export type ApiDeps = {
  readonly auth: Auth;
  readonly duck: DuckDb;
  readonly providers: ProviderDeps;
  readonly migration: MigrationResult;
  readonly duckMigration: { readonly current: string | null };
};

type Caller = { readonly userId: string; readonly apiKeyId: string | null };

const AnalyticsQuerySchema = v.object({
  days: v.optional(
    v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(365)),
    "30",
  ),
});

const RequestsQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(200)),
    "50",
  ),
});

export function createApi(deps: ApiDeps) {
  const app = new Elysia({ prefix: "/api" })
    .onError(({ code, error, path, set }) => {
      if (error instanceof InputError) {
        set.status = 422;

        return failure("validation", "request did not match the schema", error.issues);
      }

      if (code === "NOT_FOUND") {
        set.status = 404;

        return failure("not_found", `no route for ${path}`);
      }

      console.error("api: unhandled error", error);
      set.status = 500;

      return failure("internal", "unexpected server error");
    })
    .all("/auth/*", ({ request }) => deps.auth.handler(request))
    .get("/health", health(deps.migration, deps.duckMigration), { response: HealthSchema })
    .get("/providers", async ({ request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      return listProviders(deps.providers, caller.userId);
    })
    .post("/providers", async ({ body, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderInputSchema, body as ParseableInput);

      try {
        const provider = await createProvider(deps.providers, caller.userId, input);

        set.status = 201;

        return provider;
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", "a provider with that name already exists");
        }

        throw error;
      }
    })
    .put("/providers/:id", async ({ body, params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderInputSchema, body as ParseableInput);

      try {
        const provider = await updateProvider(deps.providers, caller.userId, id, input);

        if (provider === null) {
          set.status = 404;

          return failure("not_found", `provider ${id} not found`);
        }

        return provider;
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", "a provider with that name already exists");
        }

        throw error;
      }
    })
    .post("/providers/:id/models", async ({ body, params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderModelInputSchema, body as ParseableInput);

      try {
        const provider = await addProviderModel(deps.providers, caller.userId, id, input);

        if (provider === null) {
          set.status = 404;

          return failure("not_found", `provider ${id} not found`);
        }

        set.status = 201;

        return provider;
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", `the alias ${input.alias ?? input.upstreamModel} is taken`);
        }

        throw error;
      }
    })
    .delete("/providers/:id/models/:modelId", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id, modelId } = parseInput(ProviderModelParamsSchema, params);
      const provider = await removeProviderModel(deps.providers, caller.userId, id, modelId);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      return provider;
    })
    .delete("/providers/:id", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);

      if (!(await removeProvider(deps.providers, caller.userId, id))) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      set.status = 204;
    })
    .get("/analytics", async ({ query, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { days } = parseInput(AnalyticsQuerySchema, query);
      const analytics = readAnalytics(deps.duck, { userId: caller.userId, days });

      return v.parse(AnalyticsSchema, analytics);
    })
    .get("/requests", async ({ query, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { limit } = parseInput(RequestsQuerySchema, query);

      return v.parse(RequestListSchema, readRequests(deps.duck, { userId: caller.userId, limit }));
    });

  return app;
}

function health(
  migration: MigrationResult,
  duckMigration: { readonly current: string | null },
): () => Health {
  return () => ({
    ok: true,
    migration: migration.current,
    duckMigration: duckMigration.current,
  });
}

async function authenticate(auth: Auth, request: Request): Promise<Caller | Response> {
  const key = request.headers.get(API_KEY_HEADER);

  // A bad key is final: falling back to the cookie would hide a wrong key behind a live session.
  if (key !== null) {
    const verified = await auth.verifyApiKey(key);

    if (verified === null) {
      return Response.json(failure("unauthorized", "that API key is not valid"), { status: 401 });
    }

    return { userId: verified.userId, apiKeyId: verified.keyId };
  }

  const user: SessionUser | null = await auth.getSession(request.headers);

  return user === null
    ? Response.json(failure("unauthorized", "sign in to use the API"), { status: 401 })
    : { userId: user.id, apiKeyId: null };
}

function isUniqueViolation(error: Error): boolean {
  return error.message.includes("UNIQUE constraint failed");
}

function failure(code: string, message: string, issues: readonly string[] = []): ApiErrorBody {
  return { error: { code, message, issues: [...issues] } };
}
