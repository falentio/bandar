import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import * as v from "valibot";
import { AnalyticsSchema, RequestListSchema } from "../shared/analytics";
import { HealthSchema, type ApiErrorBody, type Health } from "../shared/api";
import { API_KEY_HEADER } from "../shared/api-keys";
import { CooldownListSchema } from "../shared/cooldowns";
import {
  ProviderCreateInputSchema,
  ProviderCredentialBulkInputSchema,
  ProviderCredentialInputSchema,
  ProviderCredentialOrderInputSchema,
  ProviderCredentialParamsSchema,
  ProviderCredentialProbeSchema,
  ProviderModelRefreshSchema,
  ProviderDetailSchema,
  ProviderInputSchema,
  ProviderModelInputSchema,
  ProviderModelParamsSchema,
  ProviderOAuthPollSchema,
  ProviderOAuthStartSchema,
  ProviderParamsSchema,
} from "../shared/providers";
import { TagCreateInputSchema, TagModelsInputSchema, TagParamsSchema } from "../shared/tags";
import { readAnalytics, readProviderUsage, readRequests } from "./analytics";
import { AnalyticsFiltersInputSchema, filterParams } from "./analytics-filters";
import type { Auth, SessionUser } from "./auth";
import { createBackup } from "./backup";
import type { MigrationResult } from "./db/migrate";
import { readCooldowns } from "./cooldowns";
import type { DuckDb } from "./duck/client";
import {
  addProviderCredential,
  addProviderCredentials,
  removeProviderCredential,
  reorderProviderCredentials,
  addOAuthCredential,
  type CredentialWriteResult,
} from "./credentials";
import {
  addProviderModel,
  createProvider,
  definitionFor,
  syncProviderModels,
  listProviders,
  readFirstCredential,
  readProvider,
  removeProvider,
  removeProviderModel,
  ProviderRuleError,
  updateProvider,
  type ProviderDeps,
} from "./providers";
import { probeProviderCredential } from "./providers/probe";
import { UpstreamError } from "./providers/types";
import { createTag, listTags, removeTag, setTagModels, TagRuleError } from "./tags";
import { InputError, parseInput, type ParseableInput } from "./validation";

export type ApiDeps = {
  readonly auth: Auth;
  readonly duck: DuckDb;
  readonly sqlite: Database;
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

const CooldownsQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(200)),
    "100",
  ),
});

const RequestsQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(200)),
    "50",
  ),
  providerId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
});

export function createApi(deps: ApiDeps) {
  const pendingLogins = new Map<string, { code: string; expiresAt: number }>();

  const app = new Elysia({ prefix: "/api" })
    .onError(({ code, error, path, set }) => {
      if (error instanceof InputError) {
        set.status = 422;

        return failure("validation", "request did not match the schema", error.issues);
      }

      if (error instanceof UpstreamError) {
        set.status =
          error.kind === "invalid_request" ? 400 : error.kind === "rate_limit" ? 429 : 502;

        return failure(`upstream_${error.kind}`, error.message);
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
    .get("/backup", async ({ request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const archive = await createBackup({
        sqlite: deps.sqlite,
        duck: deps.duck,
        sqliteTag: deps.migration.current,
        duckdbTag: deps.duckMigration.current,
      });

      return new Response(archive.bytes, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${archive.name}"`,
          "content-length": String(archive.bytes.byteLength),
        },
      });
    })
    .get("/providers", async ({ request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      return listProviders(deps.providers, caller.userId);
    })
    .get("/providers/:id", async ({ params, query, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      const provider = await readProvider(deps.providers, caller.userId, id);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      const { days } = parseInput(AnalyticsQuerySchema, query);

      return v.parse(ProviderDetailSchema, {
        provider,
        usage: readProviderUsage(deps.duck, {
          userId: caller.userId,
          providerId: id,
          days,
        }),
      });
    })
    .post("/providers", async ({ body, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderCreateInputSchema, body as ParseableInput);

      try {
        const provider = await createProvider(deps.providers, caller.userId, input);

        set.status = 201;

        return provider;
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", "that provider name or slug is taken");
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
        if (error instanceof ProviderRuleError) {
          set.status = providerRuleStatus(error);

          return failure(error.code, error.message);
        }

        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", "that provider name or slug is taken");
        }

        throw error;
      }
    })
    .post("/providers/:id/oauth/start", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      const provider = await readProvider(deps.providers, caller.userId, id);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      const oauth = definitionFor(provider.kind).oauth;

      if (oauth === undefined) {
        set.status = 400;

        return failure("unsupported", `${provider.kind} does not use a device login`);
      }

      const login = await oauth.start(request.signal);

      pendingLogins.set(loginKey(caller.userId, id), {
        code: login.code,
        expiresAt: Date.now() + login.expiresInSeconds * 1000,
      });

      return v.parse(ProviderOAuthStartSchema, {
        userCode: login.userCode,
        verificationUrl: login.verificationUrl,
        expiresInSeconds: login.expiresInSeconds,
        intervalSeconds: login.intervalSeconds,
      });
    })
    .post("/providers/:id/oauth/poll", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      const provider = await readProvider(deps.providers, caller.userId, id);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      const oauth = definitionFor(provider.kind).oauth;

      if (oauth === undefined) {
        set.status = 400;

        return failure("unsupported", `${provider.kind} does not use a device login`);
      }

      const key = loginKey(caller.userId, id);
      const login = pendingLogins.get(key);

      if (login === undefined) {
        set.status = 400;

        return failure("invalid_request", "start the login before polling it");
      }

      if (login.expiresAt <= Date.now()) {
        pendingLogins.delete(key);
        set.status = 400;

        return failure("invalid_request", "the login code expired; start again");
      }

      const result = await oauth.poll(login.code, request.signal);

      if (result.state === "pending") {
        return v.parse(ProviderOAuthPollSchema, { state: "pending" });
      }

      pendingLogins.delete(key);

      const saved = await addOAuthCredential(deps.providers, caller.userId, id, result.credential);

      if (saved === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      return v.parse(ProviderOAuthPollSchema, {
        state: "connected",
        authMode: result.credential.authMode,
      });
    })
    .post("/providers/:id/credentials", async ({ body, params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderCredentialInputSchema, body as ParseableInput);
      const result = await addProviderCredential(deps.providers, caller.userId, id, input);

      if (result.kind === "unsupported_mode") return unsupportedCredentialMode();

      if (result.kind !== "ok") return providerFailure(id);

      set.status = 201;

      return result.provider;
    })
    .post("/providers/:id/credentials/bulk", async ({ body, params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderCredentialBulkInputSchema, body as ParseableInput);

      const result = await addProviderCredentials(deps.providers, caller.userId, id, input.apiKeys);

      if (result.kind === "unsupported_mode") return unsupportedCredentialMode();

      if (result.kind !== "ok") return providerFailure(id);

      set.status = 201;

      return result.provider;
    })
    .put("/providers/:id/credentials/order", async ({ body, params, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(ProviderCredentialOrderInputSchema, body as ParseableInput);

      const result = await reorderProviderCredentials(
        deps.providers,
        caller.userId,
        id,
        input.credentialIds,
      );

      if (result.kind === "ok") return result.provider;

      return result.kind === "invalid_order" ? invalidCredentialOrder() : providerFailure(id);
    })
    .delete("/providers/:id/credentials/:credentialId", async ({ params, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id, credentialId } = parseInput(ProviderCredentialParamsSchema, params);

      const result = await removeProviderCredential(
        deps.providers,
        caller.userId,
        id,
        credentialId,
      );

      return result.kind === "ok" ? result.provider : credentialFailure(result, id, credentialId);
    })
    .post("/providers/:id/credentials/:credentialId/test", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id, credentialId } = parseInput(ProviderCredentialParamsSchema, params);
      const provider = await readProvider(deps.providers, caller.userId, id);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      const probe = await probeProviderCredential(
        deps.providers,
        provider,
        credentialId,
        request.signal,
      );

      if (probe === null) {
        set.status = 404;

        return failure("not_found", `credential ${credentialId} not found`);
      }

      return v.parse(ProviderCredentialProbeSchema, probe);
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
        if (error instanceof ProviderRuleError) {
          set.status = providerRuleStatus(error);

          return failure(error.code, error.message);
        }

        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", `the alias ${input.alias ?? input.upstreamModel} is taken`);
        }

        throw error;
      }
    })
    .post("/providers/:id/models/refresh", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(ProviderParamsSchema, params);
      const provider = await readProvider(deps.providers, caller.userId, id);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      const catalog = definitionFor(provider.kind).catalog;

      if (catalog === undefined) {
        set.status = 400;

        return failure("unsupported", `${provider.kind} has no model catalog to refresh`);
      }

      const models = await catalog({
        baseUrl: provider.baseUrl,
        credential: () => readFirstCredential(deps.providers, id),
        signal: request.signal,
      });

      const before = provider.models.length;
      const updated = await syncProviderModels(deps.providers, caller.userId, id, models);

      if (updated === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      return v.parse(ProviderModelRefreshSchema, {
        added: updated.models.length - before,
        skipped: models.length - (updated.models.length - before),
      });
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
      const provider = await readProvider(deps.providers, caller.userId, id);

      if (provider === null) {
        set.status = 404;

        return failure("not_found", `provider ${id} not found`);
      }

      if (provider.origin === "builtin") {
        set.status = 400;

        return failure("built_in", "a built-in provider cannot be removed");
      }

      await removeProvider(deps.providers, caller.userId, id);

      set.status = 204;
    })
    .get("/tags", async ({ request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      return listTags(deps.providers, caller.userId);
    })
    .post("/tags", async ({ body, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(TagCreateInputSchema, body as ParseableInput);

      try {
        const tags = await createTag(deps.providers, caller.userId, input.slug);

        set.status = 201;

        return tags;
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          set.status = 409;

          return failure("conflict", `the tag ${input.slug} is taken`);
        }

        throw error;
      }
    })
    .put("/tags/:id/models", async ({ body, params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(TagParamsSchema, params);
      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(TagModelsInputSchema, body as ParseableInput);

      try {
        const tags = await setTagModels(deps.providers, caller.userId, id, input.modelIds);

        if (tags === null) {
          set.status = 404;

          return failure("not_found", `tag ${id} not found`);
        }

        return tags;
      } catch (error) {
        if (error instanceof TagRuleError) {
          set.status = 422;

          return failure("validation", error.message);
        }

        throw error;
      }
    })
    .delete("/tags/:id", async ({ params, request, set }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { id } = parseInput(TagParamsSchema, params);
      const tags = await removeTag(deps.providers, caller.userId, id);

      if (tags === null) {
        set.status = 404;

        return failure("not_found", `tag ${id} not found`);
      }

      return tags;
    })
    .get("/analytics", async ({ query, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { days } = parseInput(AnalyticsQuerySchema, query);

      const filters = parseInput(
        AnalyticsFiltersInputSchema,
        filterParams(new URL(request.url).searchParams),
      );

      const analytics = readAnalytics(deps.duck, { userId: caller.userId, days, filters });

      return v.parse(AnalyticsSchema, analytics);
    })
    .get("/requests", async ({ query, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { limit, providerId } = parseInput(RequestsQuerySchema, query);

      return v.parse(
        RequestListSchema,
        readRequests(deps.duck, { userId: caller.userId, limit, providerId }),
      );
    })
    .get("/cooldowns", async ({ query, request }) => {
      const caller = await authenticate(deps.auth, request);

      if (caller instanceof Response) return caller;

      const { limit } = parseInput(CooldownsQuerySchema, query);

      return v.parse(
        CooldownListSchema,
        await readCooldowns(deps.providers.db, caller.userId, limit),
      );
    });

  return app;
}

function loginKey(userId: string, providerId: string): string {
  return `${userId}:${providerId}`;
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

function credentialFailure(
  result: Exclude<CredentialWriteResult, { kind: "ok" }>,
  providerId: string,
  credentialId: string,
): Response {
  return result.kind === "missing_credential"
    ? Response.json(failure("not_found", `credential ${credentialId} not found`), { status: 404 })
    : providerFailure(providerId);
}

function invalidCredentialOrder(): Response {
  return Response.json(failure("validation", "send every credential of this provider, in order"), {
    status: 422,
  });
}

function unsupportedCredentialMode(): Response {
  return Response.json(
    failure("unsupported_mode", "this provider connects with a device login; it takes no API key"),
    { status: 400 },
  );
}

function providerFailure(providerId: string): Response {
  return Response.json(failure("not_found", `provider ${providerId} not found`), { status: 404 });
}

function providerRuleStatus(error: ProviderRuleError): number {
  if (error.code === "built_in") return 400;

  return error.code === "conflict" ? 409 : 422;
}

function isUniqueViolation(error: Error): boolean {
  return error.message.includes("UNIQUE constraint failed");
}

function failure(code: string, message: string, issues: readonly string[] = []): ApiErrorBody {
  return { error: { code, message, issues: [...issues] } };
}
