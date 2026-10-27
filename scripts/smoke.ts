import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  AnalyticsSchema,
  RequestListSchema,
  analyticsPaths,
  type Analytics,
  type RequestEvent,
} from "../src/shared/analytics";
import { ApiErrorBodySchema, HealthSchema } from "../src/shared/api";
import { API_KEY_HEADER, CreatedApiKeySchema } from "../src/shared/api-keys";
import { AuthResultSchema } from "../src/shared/auth";
import {
  ProviderDetailSchema,
  ProviderListSchema,
  ProviderModelRefreshSchema,
  ProviderOAuthPollSchema,
  ProviderOAuthStartSchema,
  ProviderSchema,
  providerPaths,
  type Provider,
} from "../src/shared/providers";
import { TagListSchema, tagPaths } from "../src/shared/tags";

const BINARY = join(import.meta.dir, "../dist/bandar");
const JOURNAL = join(import.meta.dir, "../drizzle/meta/_journal.json");
const DUCK_DIR = join(import.meta.dir, "../duckdb");
const AUTH_SECRET = "smoke-secret-0123456789abcdef0123456789abcdef";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type Journal = { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };

type Booted = {
  readonly origin: string;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
};

const CompletionSchema = v.object({
  choices: v.array(
    v.object({
      message: v.object({ role: v.string(), content: v.string() }),
      finish_reason: v.string(),
    }),
  ),
  usage: v.optional(
    v.object({
      prompt_tokens: v.number(),
      completion_tokens: v.number(),
      total_tokens: v.number(),
    }),
  ),
});

const ModelListSchema = v.object({
  object: v.literal("list"),
  data: v.array(v.object({ id: v.string(), object: v.literal("model") })),
});

const OpenAiErrorSchema = v.object({
  error: v.object({
    message: v.string(),
    type: v.optional(v.string()),
    code: v.optional(v.nullable(v.string())),
  }),
});

const StreamChunkSchema = v.object({
  choices: v.optional(
    v.array(
      v.object({
        delta: v.object({ content: v.optional(v.string()) }),
        finish_reason: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
  usage: v.optional(
    v.object({
      prompt_tokens: v.number(),
      completion_tokens: v.number(),
      total_tokens: v.number(),
    }),
  ),
});

const expectedMigration = lastJournalTag();
const expectedDuckMigration = lastDuckTag();
const workDir = mkdtempSync(join(tmpdir(), "bandar-smoke-"));
const dbPath = join(workDir, "smoke.db");
const duckPath = join(workDir, "smoke.duckdb");
const authEmail = `${Date.now()}@smoke.test`;
const authPassword = "smoke-password-1";

const upstream = startUpstream();
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
const kilocode = startKilocode();
const kilocodeOrigin = `http://127.0.0.1:${kilocode.port}`;

let failures = 0;
let cookie = "";
let openaiProvider: ProviderSlot = { provider: null, modelId: "" };
let claudeProvider: ProviderSlot = { provider: null, modelId: "" };
const kiloProvider: ProviderSlot = { provider: null, modelId: "" };
let apiKey = "";
let keyId = "";

const first = await boot(await reservePort());
const origin = first.origin;
const requestOrigin = originHeader(origin);

try {
  await check("GET / serves the client shell", async () => {
    const response = await fetch(new URL("/", origin));
    assert.equal(response.status, 200);
    assert.match(contentType(response), /^text\/html/);
    assert.match(await response.text(), /id="root"/);
  });

  await check("GET /overview serves the client shell for a router deep link", async () => {
    const response = await fetch(new URL("/overview", origin));
    assert.equal(response.status, 200);
    assert.match(contentType(response), /^text\/html/);
    assert.match(await response.text(), /id="root"/);
  });

  await check("GET /api/health reports both embedded migrations", async () => {
    const health = await getJson("/api/health", HealthSchema, 200);
    assert.equal(health.migration, expectedMigration);
    assert.equal(health.duckMigration, expectedDuckMigration);
  });

  await check("GET /v1/models without a key is an OpenAI 401", async () => {
    const response = await fetch(new URL("/v1/models", origin));
    assert.equal(response.status, 401);
    assert.match(contentType(response), /application\/json/);
    const error = await openAiError(response);
    assert.equal(error.code, "unauthorized");
  });

  await check("POST /api/auth/sign-up/email starts a session", async () => {
    const response = await post(
      "/api/auth/sign-up/email",
      { name: "Smoke", email: authEmail, password: authPassword },
      { origin: requestOrigin },
    );

    assert.equal(response.status, 200);

    const result = v.parse(AuthResultSchema, await response.json());
    assert.equal(result.user.email, authEmail);

    cookie = sessionCookie(response);
  });

  await check("GET /api/providers seeds the built-in Kilo Code provider", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const builtIn = list.providers.find((provider) => provider.origin === "builtin");

    if (builtIn === undefined) throw new Error("the built-in Kilo Code provider is missing");

    assert.equal(builtIn.kind, "kilocode");
    assert.equal(builtIn.name, "Kilo Code");
    assert.equal(builtIn.slug, "kilo");
    assert.equal(builtIn.baseUrl, `${kilocodeOrigin}/api/openrouter`);
    assert.deepEqual(builtIn.authModes, ["api-key", "oauth"]);
    assert.deepEqual(builtIn.credentials, []);
    assert.deepEqual(builtIn.models, []);

    kiloProvider.provider = builtIn;
  });

  await check("POST /api/providers creates a provider without models", async () => {
    openaiProvider.provider = await postJson(
      providerPaths.list,
      {
        name: "Fake OpenAI",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "openai-key",
      },
      ProviderSchema,
      201,
    );

    assert.equal(openaiProvider.provider?.credentials.length, 1);
    assert.deepEqual(openaiProvider.provider?.models, []);
    assert.equal(Object.hasOwn(openaiProvider.provider?.credentials[0] ?? {}, "apiKey"), false);
  });

  await check("POST /api/providers/:id/models adds an alias to a provider", async () => {
    const provider = await postJson(
      providerPaths.models(openaiProvider.provider?.id ?? ""),
      { upstreamModel: "fake-openai-model", alias: "fast" },
      ProviderSchema,
      201,
    );

    openaiProvider.provider = provider;
    openaiProvider.modelId = provider.models[0]?.id ?? "";

    assert.deepEqual(
      provider.models.map((model) => [model.alias, model.upstreamModel]),
      [["fast", "fake-openai-model"]],
    );
  });

  await check("POST /api/providers creates Anthropic and Google providers", async () => {
    claudeProvider.provider = await postJson(
      providerPaths.list,
      {
        name: "Fake Anthropic",
        kind: "anthropic",
        baseUrl: `${upstreamOrigin}/anthropic`,
        apiKey: "anthropic-key",
      },
      ProviderSchema,
      201,
    );

    const seeded = await postJson(
      providerPaths.models(claudeProvider.provider?.id ?? ""),
      { upstreamModel: "fake-claude", alias: "claude" },
      ProviderSchema,
      201,
    );

    claudeProvider.modelId = seeded.models[0]?.id ?? "";

    const google = await postJson(
      providerPaths.list,
      {
        name: "Fake Google",
        kind: "google",
        baseUrl: `${upstreamOrigin}/google`,
        apiKey: "google-key",
      },
      ProviderSchema,
      201,
    );

    await postJson(
      providerPaths.models(google.id),
      { upstreamModel: "fake-gemini", alias: "gemini" },
      ProviderSchema,
      201,
    );
  });

  await check("GET /api/providers lists three custom providers and the built-in Kilo", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const custom = list.providers.filter((provider) => provider.origin === "custom");
    const builtIn = list.providers.filter((provider) => provider.origin === "builtin");

    assert.equal(custom.length, 3);
    assert.equal(builtIn.length, 1);
    assert.equal(list.providers[0]?.origin, "builtin");
    assert.ok(custom.every((provider) => provider.credentials.length > 0));
    assert.equal(builtIn[0]?.credentials.length, 0);
    assert.ok(list.providers.every((provider) => !Object.hasOwn(provider, "apiKey")));
  });

  await check("POST /api/providers rejects a duplicate provider name with 409", async () => {
    const response = await post(providerPaths.list, {
      name: "Fake OpenAI",
      kind: "openai",
      baseUrl: `${upstreamOrigin}/openai`,
      apiKey: "",
    });

    assert.equal(response.status, 409);
    assert.equal((await errorBody(response)).code, "conflict");
  });

  await check("POST /api/providers/:id/models rejects a duplicate alias with 409", async () => {
    const response = await post(providerPaths.models(claudeProvider.provider?.id ?? ""), {
      upstreamModel: "other-model",
      alias: "fast",
    });

    assert.equal(response.status, 409);
    assert.equal((await errorBody(response)).code, "conflict");

    const duplicateUpstream = await post(providerPaths.models(openaiProvider.provider?.id ?? ""), {
      upstreamModel: "fake-openai-model",
      alias: "fast-2",
    });

    assert.equal(duplicateUpstream.status, 409);
    assert.equal((await errorBody(duplicateUpstream)).code, "conflict");
  });

  await check(
    "DELETE /api/providers/:id/models/:modelId removes a model and its alias",
    async () => {
      assert.notEqual(claudeProvider.modelId, "");

      const removed = await deleteJson(
        providerPaths.model(claudeProvider.provider?.id ?? "", claudeProvider.modelId),
        ProviderSchema,
      );

      assert.deepEqual(removed.models, []);
      apiKey = await mintGatewayKey();
      const models = await fetch(new URL("/v1/models", origin), { headers: bearer() });

      const body = v.parse(ModelListSchema, await models.json());

      assert.deepEqual(
        body.data.map((model) => model.id).sort(),
        ["fake-google/fake-gemini", "fake-openai/fake-openai-model", "fast", "gemini"],
        `aliases after the removal: ${body.data.map((model) => model.id).join(", ")}`,
      );

      const restored = await postJson(
        providerPaths.models(claudeProvider.provider?.id ?? ""),
        { upstreamModel: "fake-claude", alias: "claude" },
        ProviderSchema,
        201,
      );

      claudeProvider.modelId = restored.models[0]?.id ?? "";
    },
  );

  await check("POST /api/auth/api-key/create mints a gateway key", async () => {
    const minted = await mintGatewayKey();

    assert.ok(minted.startsWith("bandar_"), `key ${minted} lacks the bandar_ prefix`);
  });

  await check("GET /v1/models lists aliases and provider refs", async () => {
    const response = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    assert.equal(response.status, 200);

    const body = v.parse(ModelListSchema, await response.json());

    assert.deepEqual(body.data.map((model) => model.id).sort(), [
      "claude",
      "fake-anthropic/fake-claude",
      "fake-google/fake-gemini",
      "fake-openai/fake-openai-model",
      "fast",
      "gemini",
    ]);
  });

  await check("POST /v1/chat/completions non-streaming routes to OpenAI", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify(chat("fast", false, "openai")),
    });

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());
    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI");
    assert.deepEqual(body.usage, {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
  });

  await check("POST /v1/chat/completions streams Anthropic via x-api-key", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...keyHeaders() },
      body: JSON.stringify(chat("claude", true, "anthropic")),
    });

    assert.equal(response.status, 200);
    assert.match(contentType(response), /text\/event-stream/);

    const stream = await readStream(response);
    assert.equal(stream.text, "Hello from Anthropic");
    assert.equal(stream.usage?.completion_tokens, 5);
    assert.equal(stream.usage?.prompt_tokens, 9);
    assert.ok(stream.done, "the stream did not end with [DONE]");
  });

  await check("POST /v1/chat/completions streams Google", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify(chat("gemini", true, "google")),
    });

    assert.equal(response.status, 200);

    const stream = await readStream(response);
    assert.equal(stream.text, "Hello from Google");
    assert.equal(stream.usage?.completion_tokens, 6);
    assert.equal(stream.usage?.prompt_tokens, 4);
    assert.ok(stream.done, "the stream did not end with [DONE]");
  });

  await check("an unknown alias is a 404 model_not_found", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify(chat("missing", false, "openai")),
    });

    assert.equal(response.status, 404);
    assert.equal((await openAiError(response)).code, "model_not_found");
  });

  await check("a bad gateway key is a 401", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bandar_nope" },
      body: JSON.stringify(chat("fast", false, "openai")),
    });

    assert.equal(response.status, 401);
  });

  await check("analytics records tokens, TTFT and tokens per second", async () => {
    const analytics = await waitForAnalytics(3);
    assert.equal(analytics.daily.length, 30);
    assert.ok(analytics.summary.requests >= 3, `only ${analytics.summary.requests} requests`);
    assert.equal(analytics.summary.inputTokens, 24);
    assert.equal(analytics.summary.outputTokens, 18);
    assert.equal(analytics.summary.avgTokensPerDay, 1.4);
    assert.ok(analytics.summary.avgTps !== null && analytics.summary.avgTps > 0);
    assert.equal(analytics.summary.errorRate, 0);

    const requests = await getJson(`${analyticsPaths.requests}?limit=10`, RequestListSchema, 200);
    const streaming = requests.requests.find((request) => request.model === "claude");

    assert.ok(streaming, "the anthropic request is missing");
    assert.equal(streaming.streamed, true);
    assert.ok(streaming.ttftMs !== null && streaming.ttftMs >= 0);
    assert.ok(
      streaming.tokensPerSecond !== null && streaming.tokensPerSecond > 0,
      "streaming request has no tokens per second",
    );
  });

  await check("GET /api/providers/:id returns the provider and its usage", async () => {
    const id = claudeProvider.provider?.id ?? "";
    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.equal(detail.provider.id, id);
    assert.equal(detail.usage.days, 30);
    assert.equal(detail.usage.requests, 1);
    assert.ok(detail.usage.inputTokens > 0);
    assert.ok(detail.usage.lastRequestAt !== null);

    const requests = await getJson(
      `${analyticsPaths.requests}?limit=10&providerId=${id}`,
      RequestListSchema,
      200,
    );

    assert.deepEqual(
      requests.requests.map((request) => request.model),
      ["claude"],
    );
  });

  await check("GET /api/analytics filters by provider, account and model", async () => {
    const anthropicOnly = await getJson(
      `${analyticsPaths.analytics}?days=30&providerKind=anthropic`,
      AnalyticsSchema,
      200,
    );

    assert.equal(anthropicOnly.summary.requests, 1);
    assert.deepEqual(
      anthropicOnly.models.map((model) => model.model),
      ["claude"],
    );

    const account = await getJson(
      `${analyticsPaths.analytics}?days=30&providerId=${claudeProvider.provider?.id ?? ""}`,
      AnalyticsSchema,
      200,
    );

    assert.equal(account.summary.requests, 1);

    const models = await getJson(
      `${analyticsPaths.analytics}?days=30&model=fast`,
      AnalyticsSchema,
      200,
    );

    assert.equal(models.summary.requests, 1);
    assert.equal(models.summary.inputTokens, 11);

    const twoKinds = await getJson(
      `${analyticsPaths.analytics}?days=30&providerKind=openai&providerKind=google`,
      AnalyticsSchema,
      200,
    );

    assert.equal(twoKinds.summary.requests, 2);

    const none = await getJson(
      `${analyticsPaths.analytics}?days=30&model=absent`,
      AnalyticsSchema,
      200,
    );

    assert.equal(none.summary.requests, 0);
    assert.equal(none.daily.length, 30);
  });
  await check("POST /api/providers cannot create another built-in provider", async () => {
    const response = await post(providerPaths.list, {
      name: "Another Kilo",
      kind: "kilocode",
      baseUrl: `${kilocodeOrigin}/api/openrouter`,
    });

    assert.equal(response.status, 422);
  });

  await check("built-in provider settings and removal are protected", async () => {
    const id = kiloProvider.provider?.id ?? "";
    const builtIn = kiloProvider.provider;

    if (builtIn === null) throw new Error("the built-in provider is missing");

    const noop = await fetch(new URL(providerPaths.update(id), origin), {
      method: "PUT",
      headers: { "content-type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({
        name: builtIn.name,
        kind: builtIn.kind,
        baseUrl: builtIn.baseUrl,
        slug: builtIn.slug,
      }),
    });

    assert.equal(noop.status, 200);
    assert.equal(v.parse(ProviderSchema, await noop.json()).slug, "kilo");

    const update = await fetch(new URL(providerPaths.update(id), origin), {
      method: "PUT",
      headers: { "content-type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({
        name: "Renamed Kilo",
        kind: "kilocode",
        baseUrl: "https://example.com",
      }),
    });

    assert.equal(update.status, 400);

    const remove = await fetch(new URL(providerPaths.remove(id), origin), {
      method: "DELETE",
      headers: sessionHeaders(),
    });

    assert.equal(remove.status, 400);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.equal(detail.provider.name, "Kilo Code");
    assert.equal(detail.provider.baseUrl, `${kilocodeOrigin}/api/openrouter`);
  });

  await check("POST /api/providers/:id/oauth/start returns a device code", async () => {
    const start = await postJson(
      providerPaths.oauthStart(kiloProvider.provider?.id ?? ""),
      {},
      ProviderOAuthStartSchema,
      200,
    );

    assert.equal(start.userCode, "SMOK-CODE");
    assert.match(start.verificationUrl, /device-auth/);
    assert.equal(start.expiresInSeconds, 600);
  });

  await check("POST /api/providers/:id/oauth/poll waits, then stores the connection", async () => {
    const id = kiloProvider.provider?.id ?? "";

    const first = await postJson(providerPaths.oauthPoll(id), {}, ProviderOAuthPollSchema, 200);

    assert.equal(first.state, "pending");

    const second = await postJson(providerPaths.oauthPoll(id), {}, ProviderOAuthPollSchema, 200);

    assert.equal(second.state, "connected");
    assert.equal(second.authMode, "oauth");

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.equal(detail.provider.credentials.length, 1);
    assert.equal(detail.provider.credentials[0]?.authMode, "oauth");
    assert.equal(Object.hasOwn(detail.provider, "apiKey"), false);
  });

  await check("POST /api/providers/:id/oauth/poll needs a started login", async () => {
    const response = await post(providerPaths.oauthPoll(kiloProvider.provider?.id ?? ""), {});

    assert.equal(response.status, 400);
  });

  await check("OAuth and catalog routes reject API-key kinds", async () => {
    const id = openaiProvider.provider?.id ?? "";

    assert.equal((await post(providerPaths.oauthStart(id), {})).status, 400);
    assert.equal((await post(providerPaths.refreshModels(id), {})).status, 400);
  });

  await check("POST /api/providers/:id/models/refresh imports the catalog once", async () => {
    const id = kiloProvider.provider?.id ?? "";

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 4);
    assert.equal(refresh.skipped, 1);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.deepEqual(detail.provider.models.map((model) => model.alias).sort(), [
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4:free",
      "kilo-auto/free",
      "openai/gpt-5-codex",
    ]);

    const sonnet = detail.provider.models.find(
      (model) => model.alias === "anthropic/claude-sonnet-4",
    );

    const free = detail.provider.models.find((model) => model.alias === "kilo-auto/free");
    const auto = detail.provider.models.find((model) => model.alias === "openai/gpt-5-codex");

    assert.equal(sonnet?.inputPricePerMtok, 3);
    assert.equal(sonnet?.outputPricePerMtok, 15);
    assert.equal(free?.inputPricePerMtok, 0);
    assert.equal(auto?.inputPricePerMtok, null);

    const again = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(again.added, 0);
    assert.equal(again.skipped, 5);
  });

  await check("POST /v1/chat/completions streams Kilo Code with the connection", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify(chat("anthropic/claude-sonnet-4", true, "kilocode")),
    });

    assert.equal(response.status, 200);

    const text = await response.text();

    assert.match(text, /"content":"Hello"/);
    assert.match(text, /"content":" from Kilo"/);
    assert.match(text, /data: \[DONE\]/);
  });

  await check("POST /v1/chat/completions reads a non-streamed Kilo Code answer", async () => {
    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify(chat("openai/gpt-5-codex", false, "kilocode")),
    });

    assert.equal(response.status, 200);

    const body = v.parse(
      v.object({
        choices: v.array(
          v.object({ message: v.object({ content: v.string() }), finish_reason: v.string() }),
        ),
        usage: v.object({ prompt_tokens: v.number(), completion_tokens: v.number() }),
      }),
      await response.json(),
    );

    assert.equal(body.choices[0]?.message.content, "Hello from Kilo");
    assert.equal(body.choices[0]?.finish_reason, "stop");
    assert.equal(body.usage.prompt_tokens, 3);
    assert.equal(body.usage.completion_tokens, 4);
  });

  await check("providers carry derived slugs and model refs", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const byName = new Map(list.providers.map((provider) => [provider.name, provider]));

    assert.equal(byName.get("Fake OpenAI")?.slug, "fake-openai");
    assert.equal(byName.get("Fake Anthropic")?.slug, "fake-anthropic");
    assert.equal(byName.get("Fake Google")?.slug, "fake-google");
    assert.equal(byName.get("Kilo Code")?.slug, "kilo");

    const fast = byName.get("Fake OpenAI")?.models.find((model) => model.alias === "fast");

    assert.equal(fast?.ref, "fake-openai/fake-openai-model");
    assert.equal(fast?.shadowed, false);
  });

  await check("a provider ref answers inference and records the reference", async () => {
    const response = await chatRequest("fake-openai/fake-openai-model", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI");

    const rows = await waitForRequests(
      "fake-openai/fake-openai-model",
      (requests) => requests.some((request) => request.status === "success"),
      "the provider-ref success",
    );

    assert.equal(rows.find((request) => request.status === "success")?.model, "fast");

    const wrongCase = await chatRequest("FAKE-OPENAI/fake-openai-model", false);

    assert.equal(wrongCase.status, 404);
    assert.equal((await openAiError(wrongCase)).code, "model_not_found");
  });

  await check("a tag falls back to the next model and records one event per attempt", async () => {
    const dead = await postJson(
      providerPaths.list,
      {
        name: "Dead",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "wrong-key",
      },
      ProviderSchema,
      201,
    );

    const deadProvider = await postJson(
      providerPaths.models(dead.id),
      { upstreamModel: "dead-model" },
      ProviderSchema,
      201,
    );

    const deadModelId = deadProvider.models[0]?.id ?? "";
    const fastModelId = openaiProvider.modelId;

    assert.notEqual(deadModelId, "");
    assert.notEqual(fastModelId, "");

    const created = await postJson(tagPaths.create, { slug: "failover" }, TagListSchema, 201);
    const tagId = created.tags.find((tag) => tag.slug === "failover")?.id ?? "";

    assert.notEqual(tagId, "");

    await putJson(
      tagPaths.models(tagId),
      { modelIds: [deadModelId, fastModelId] },
      TagListSchema,
      200,
    );

    const response = await chatRequest("tags/failover", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI");

    const rows = await waitForRequests(
      "tags/failover",
      (requests) =>
        requests.some((request) => request.status === "error") &&
        requests.some((request) => request.status === "success"),
      "both fallback attempts",
    );

    assert.equal(rows.find((request) => request.status === "error")?.model, "dead-model");
    assert.equal(rows.find((request) => request.status === "success")?.model, "fast");

    await putJson(
      tagPaths.models(tagId),
      { modelIds: [fastModelId, deadModelId] },
      TagListSchema,
      200,
    );

    const flipped = await chatRequest("tags/failover", false);

    assert.equal(flipped.status, 200);

    const flippedBody = v.parse(CompletionSchema, await flipped.json());

    assert.equal(flippedBody.choices[0]?.message.content, "Hello from OpenAI");

    const settled = await waitForRequests(
      "tags/failover",
      (requests) => requests.filter((request) => request.status === "success").length === 2,
      "the flipped success",
    );

    assert.equal(settled.filter((request) => request.status === "error").length, 1);
  });

  await check("GET /v1/models and GET /api/tags list the tag in priority order", async () => {
    const response = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await response.json());

    assert.ok(models.data.some((model) => model.id === "tags/failover"));

    const list = await getJson(tagPaths.list, TagListSchema, 200);
    const tag = list.tags.find((entry) => entry.slug === "failover");

    assert.equal(tag?.ref, "tags/failover");
    assert.deepEqual(
      tag?.models.map((model) => model.alias),
      ["fast", "dead-model"],
      `failover order: ${tag?.models.map((model) => model.alias).join(", ")}`,
    );
  });

  await check("a streaming tag retries the failed model", async () => {
    const list = await getJson(tagPaths.list, TagListSchema, 200);
    const tag = list.tags.find((entry) => entry.slug === "failover");

    if (tag === undefined) throw new Error("the failover tag is missing");

    const dead = tag.models.find((model) => model.alias === "dead-model");
    const fast = tag.models.find((model) => model.alias === "fast");

    if (dead === undefined || fast === undefined)
      throw new Error("the failover models are missing");

    await putJson(
      tagPaths.models(tag.id),
      { modelIds: [dead.modelId, fast.modelId] },
      TagListSchema,
      200,
    );

    const response = await chatRequest("tags/failover", true);

    assert.equal(response.status, 200);

    const stream = await readStream(response);

    assert.equal(stream.text, "Hello from OpenAI");
    assert.ok(stream.done);
  });

  await check("a credential fallback answers when the first key is rejected", async () => {
    const provider = await postJson(
      providerPaths.list,
      {
        name: "Rotating",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "wrong-key",
      },
      ProviderSchema,
      201,
    );

    const withModel = await postJson(
      providerPaths.models(provider.id),
      { upstreamModel: "fake-openai-model", alias: "rotating" },
      ProviderSchema,
      201,
    );

    assert.equal(withModel.models[0]?.alias, "rotating");

    const added = await postJson(
      providerPaths.credentials(provider.id),
      { label: "work", apiKey: "openai-key" },
      ProviderSchema,
      201,
    );

    assert.deepEqual(
      added.credentials.map((credential) => [
        credential.priority,
        credential.label,
        credential.authMode,
      ]),
      [
        [1, "", "api-key"],
        [2, "work", "api-key"],
      ],
    );
    assert.equal(
      Object.hasOwn(added.credentials[0] ?? {}, "apiKey"),
      false,
      "the provider returned a credential secret",
    );

    const response = await chatRequest("rotating", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI");

    const rows = await waitForRequests(
      "rotating",
      (requests) => requests.some((request) => request.status === "success"),
      "the credential fallback success",
    );

    assert.deepEqual(rows.map((request) => request.status).sort(), ["error", "success"]);
    assert.equal(rows.find((request) => request.status === "error")?.errorKind, "auth");
  });

  await check(
    "POST /api/providers/:id/credentials/bulk appends every key in one write",
    async () => {
      const provider = await postJson(
        providerPaths.list,
        {
          name: "Bulk",
          kind: "openai",
          baseUrl: `${upstreamOrigin}/openai`,
          apiKey: "bulk-first",
        },
        ProviderSchema,
        201,
      );

      const added = await postJson(
        providerPaths.credentialsBulk(provider.id),
        { apiKeys: ["bulk-one", "bulk-two", "bulk-three"] },
        ProviderSchema,
        201,
      );

      assert.deepEqual(
        added.credentials.map((credential) => [credential.priority, credential.authMode]),
        [
          [1, "api-key"],
          [2, "api-key"],
          [3, "api-key"],
          [4, "api-key"],
        ],
      );
      assert.equal(Object.hasOwn(added.credentials[0] ?? {}, "apiKey"), false);

      const empty = await post(providerPaths.credentialsBulk(provider.id), { apiKeys: [] });

      const repeated = await post(providerPaths.credentialsBulk(provider.id), {
        apiKeys: ["same", "same"],
      });

      const absent = await post(providerPaths.credentialsBulk("absent-provider"), {
        apiKeys: ["bulk-one"],
      });

      assert.equal(empty.status, 422);
      assert.equal(repeated.status, 422);
      assert.equal(absent.status, 404);
    },
  );

  await check("reordering and removing credentials rewrites the chain", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const provider = list.providers.find((entry) => entry.name === "Rotating");

    if (provider === undefined) throw new Error("the Rotating provider is missing");

    const rejected = provider.credentials[0];
    const working = provider.credentials[1];

    if (rejected === undefined || working === undefined)
      throw new Error("the Rotating provider needs two credentials");

    const partial = await put(providerPaths.credentialOrder(provider.id), {
      credentialIds: [working.id],
    });

    assert.equal(partial.status, 422);

    const reordered = await putJson(
      providerPaths.credentialOrder(provider.id),
      { credentialIds: [working.id, rejected.id] },
      ProviderSchema,
      200,
    );

    assert.deepEqual(
      reordered.credentials.map((credential) => [credential.id, credential.priority]),
      [
        [working.id, 1],
        [rejected.id, 2],
      ],
    );

    const response = await chatRequest("rotating", false);

    assert.equal(response.status, 200);

    const settled = await waitForRequests(
      "rotating",
      (requests) => requests.filter((request) => request.status === "success").length === 2,
      "the reordered success",
    );

    assert.equal(
      settled.filter((request) => request.status === "error").length,
      1,
      "the reordered chain retried the rejected key",
    );

    const settings = await putJson(
      providerPaths.update(provider.id),
      {
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: "ignored-key",
      },
      ProviderSchema,
      200,
    );

    assert.deepEqual(
      settings.credentials.map((credential) => credential.id),
      [working.id, rejected.id],
      "the settings route wrote a credential",
    );

    const removed = await deleteJson(
      providerPaths.credential(provider.id, working.id),
      ProviderSchema,
    );

    assert.deepEqual(
      removed.credentials.map((credential) => [credential.id, credential.priority]),
      [[rejected.id, 1]],
    );

    const foreign = await fetch(
      new URL(providerPaths.credential(provider.id, claudeProvider.provider?.id ?? ""), origin),
      { method: "DELETE", headers: sessionHeaders() },
    );

    assert.equal(foreign.status, 404);
  });

  await check("a tag with no models is a 404 and stays out of /v1/models", async () => {
    await postJson(tagPaths.create, { slug: "empty" }, TagListSchema, 201);

    const response = await chatRequest("tags/empty", false);

    assert.equal(response.status, 404);

    const error = await openAiError(response);

    assert.equal(error.code, "model_not_found");
    assert.match(error.message, /tag empty has no enabled models/);

    const models = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const body = v.parse(ModelListSchema, await models.json());

    assert.equal(
      body.data.some((model) => model.id === "tags/empty"),
      false,
      "an empty tag was listed",
    );
  });

  await check("GET /api/analytics filters by tag and intersects with a model", async () => {
    const tag = await getJson(
      `${analyticsPaths.analytics}?days=30&tag=failover`,
      AnalyticsSchema,
      200,
    );

    assert.ok(tag.summary.requests >= 5, `tag filter saw ${tag.summary.requests} requests`);
    assert.deepEqual(tag.models.map((model) => model.model).sort(), ["dead-model", "fast"]);

    const narrowed = await getJson(
      `${analyticsPaths.analytics}?days=30&tag=failover&model=fast`,
      AnalyticsSchema,
      200,
    );

    assert.ok(narrowed.summary.requests < tag.summary.requests);
    assert.deepEqual(
      narrowed.models.map((model) => model.model),
      ["fast"],
    );

    const absent = await getJson(
      `${analyticsPaths.analytics}?days=30&tag=absent`,
      AnalyticsSchema,
      200,
    );

    assert.equal(absent.summary.requests, 0);
  });
  await check("an alias wins over an identical provider ref", async () => {
    const provider = await postJson(
      providerPaths.list,
      {
        name: "Anthropic",
        kind: "anthropic",
        baseUrl: `${upstreamOrigin}/anthropic`,
        apiKey: "anthropic-key",
      },
      ProviderSchema,
      201,
    );

    assert.equal(provider.slug, "anthropic");

    const withModel = await postJson(
      providerPaths.models(provider.id),
      { upstreamModel: "claude-sonnet-4" },
      ProviderSchema,
      201,
    );

    const model = withModel.models.find((entry) => entry.upstreamModel === "claude-sonnet-4");

    assert.equal(model?.ref, "anthropic/claude-sonnet-4");
    assert.equal(model?.shadowed, true);

    const response = await chatRequest("anthropic/claude-sonnet-4", true);

    assert.equal(response.status, 200);

    const stream = await readStream(response);

    assert.equal(stream.text, "Hello from Kilo");

    const listed = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await listed.json());

    assert.equal(
      models.data.filter((model) => model.id === "anthropic/claude-sonnet-4").length,
      1,
      "the shadowed provider ref was listed twice",
    );
  });

  await check("reserved refs and slugs are rejected", async () => {
    const reservedAlias = await post(providerPaths.models(openaiProvider.provider?.id ?? ""), {
      upstreamModel: "reserved-model",
      alias: "tags/x",
    });

    assert.equal(reservedAlias.status, 422);

    const badTag = await post(tagPaths.create, { slug: "Nope" });

    assert.equal(badTag.status, 422);

    const named = await postJson(
      providerPaths.list,
      {
        name: "Tags",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "",
      },
      ProviderSchema,
      201,
    );

    assert.equal(named.slug, "tags-2");

    const reservedSlug = await put(providerPaths.update(named.id), {
      name: named.name,
      kind: named.kind,
      baseUrl: named.baseUrl,
      slug: "kilo",
    });

    assert.equal(reservedSlug.status, 422);

    const wrongWire = await put(providerPaths.update(named.id), {
      name: named.name,
      kind: "kilocode",
      baseUrl: named.baseUrl,
    });

    assert.equal(wrongWire.status, 422);
    assert.equal((await errorBody(wrongWire)).code, "validation");
  });

  await check("a custom slug edit replaces the old provider ref", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const named = list.providers.find((provider) => provider.name === "Tags");

    if (named === undefined) throw new Error("the Tags provider is missing");

    const withModel = await postJson(
      providerPaths.models(named.id),
      { upstreamModel: "named-model", alias: "named-fast" },
      ProviderSchema,
      201,
    );

    assert.ok(withModel.models.some((model) => model.ref === "tags-2/named-model"));

    const edited = await putJson(
      providerPaths.update(named.id),
      { name: named.name, kind: named.kind, baseUrl: named.baseUrl, slug: "custom-tags" },
      ProviderSchema,
      200,
    );

    assert.equal(edited.slug, "custom-tags");

    const listed = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await listed.json());
    const ids = models.data.map((model) => model.id);

    assert.equal(ids.includes("tags-2/named-model"), false);
    assert.equal(ids.includes("custom-tags/named-model"), true);

    const oldRef = await chatRequest("tags-2/named-model", false);

    assert.equal(oldRef.status, 404);
    assert.equal((await openAiError(oldRef)).code, "model_not_found");
  });

  await check("deleting a tag returns the list, and a deleted model leaves its tags", async () => {
    const before = await getJson(tagPaths.list, TagListSchema, 200);
    const empty = before.tags.find((tag) => tag.slug === "empty");

    assert.ok(empty, "the empty tag is missing");

    const removed = await deleteJson(tagPaths.remove(empty.id), TagListSchema);

    assert.equal(
      removed.tags.some((tag) => tag.slug === "empty"),
      false,
    );
    assert.ok(removed.tags.some((tag) => tag.slug === "failover"));

    await deleteJson(
      providerPaths.model(openaiProvider.provider?.id ?? "", openaiProvider.modelId),
      ProviderSchema,
    );

    const after = await getJson(tagPaths.list, TagListSchema, 200);
    const failover = after.tags.find((tag) => tag.slug === "failover");

    assert.deepEqual(
      failover?.models.map((model) => model.alias),
      ["dead-model"],
      `failover order after the model removal: ${failover?.models.map((model) => model.alias).join(", ")}`,
    );
    assert.deepEqual(
      failover?.models.map((model) => model.priority),
      [1],
      `failover priorities after the model removal: ${failover?.models.map((model) => model.priority).join(", ")}`,
    );
  });

  await check("deleting a provider removes its models and tag memberships", async () => {
    const provider = await postJson(
      providerPaths.list,
      {
        name: "Cascade",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "openai-key",
      },
      ProviderSchema,
      201,
    );

    const withModel = await postJson(
      providerPaths.models(provider.id),
      { upstreamModel: "cascade-model", alias: "cascade-alias" },
      ProviderSchema,
      201,
    );

    const model = withModel.models.find((entry) => entry.alias === "cascade-alias");

    if (model === undefined) throw new Error("the cascade model is missing");

    const created = await postJson(tagPaths.create, { slug: "cascade" }, TagListSchema, 201);
    const tag = created.tags.find((entry) => entry.slug === "cascade");

    if (tag === undefined) throw new Error("the cascade tag is missing");

    await putJson(tagPaths.models(tag.id), { modelIds: [model.id] }, TagListSchema, 200);

    const removed = await fetch(new URL(providerPaths.remove(provider.id), origin), {
      method: "DELETE",
      headers: sessionHeaders(),
    });

    assert.equal(removed.status, 204);

    const tags = await getJson(tagPaths.list, TagListSchema, 200);

    assert.deepEqual(tags.tags.find((entry) => entry.slug === "cascade")?.models, []);

    const listed = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await listed.json());

    assert.equal(
      models.data.some(
        (entry) => entry.id === "cascade-alias" || entry.id === "cascade/cascade-model",
      ),
      false,
    );
  });

  await check("the longest provider ref is callable", async () => {
    const created = await postJson(
      providerPaths.list,
      {
        name: "Long Ref",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "openai-key",
      },
      ProviderSchema,
      201,
    );

    const slug = "l".repeat(40);

    const updated = await putJson(
      providerPaths.update(created.id),
      { name: created.name, kind: created.kind, baseUrl: created.baseUrl, slug },
      ProviderSchema,
      200,
    );

    assert.equal(updated.slug, slug);

    const withModel = await postJson(
      providerPaths.models(created.id),
      { upstreamModel: "m".repeat(200), alias: "long-ref" },
      ProviderSchema,
      201,
    );

    const ref = withModel.models.find((model) => model.alias === "long-ref")?.ref ?? "";

    assert.equal(ref.length, 241);

    const response = await chatRequest(ref, false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI");

    const models = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const list = v.parse(ModelListSchema, await models.json());

    assert.ok(list.data.some((model) => model.id === ref));
  });

  await check("GET /api/providers/:id hides another account's provider", async () => {
    const response = await fetch(
      new URL(`${providerPaths.detail("00000000-0000-0000-0000-000000000000")}?days=30`, origin),
      { headers: sessionHeaders() },
    );

    assert.equal(response.status, 404);
  });

  await check("POST /api/auth/sign-out ends the session", async () => {
    const response = await post("/api/auth/sign-out", {}, { origin: requestOrigin });
    assert.equal(response.status, 200);
  });

  await check("the old session cookie no longer reads analytics", async () => {
    const response = await fetch(new URL(analyticsPaths.analytics, origin), {
      headers: sessionHeaders(),
    });

    assert.equal(response.status, 401);
    cookie = "";
  });

  await check("a revoked gateway key is a 401", async () => {
    const signIn = await post(
      "/api/auth/sign-in/email",
      { email: authEmail, password: authPassword },
      { origin: requestOrigin },
    );

    assert.equal(signIn.status, 200);
    cookie = sessionCookie(signIn);

    const revoked = await post("/api/auth/api-key/delete", { keyId }, { origin: requestOrigin });
    assert.equal(revoked.status, 200);

    const response = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    assert.equal(response.status, 401);
  });
} finally {
  await first.stop();
}

const second = await boot(await reservePort());

try {
  await check("a second boot applies neither migration and keeps DuckDB events", async () => {
    assert.match(second.log(), /sqlite: 0 applied/);
    assert.match(second.log(), /duckdb: 0 applied/);
    assert.doesNotMatch(second.log(), /assigned \d+ provider slug/);
    cookie = "";

    const signIn = await post(
      "/api/auth/sign-in/email",
      { email: authEmail, password: authPassword },
      { origin: originHeader(second.origin) },
      second.origin,
    );

    assert.equal(signIn.status, 200);
    cookie = sessionCookie(signIn);

    const analytics = await getJson(
      `${analyticsPaths.analytics}?days=30`,
      AnalyticsSchema,
      200,
      second.origin,
    );

    assert.ok(analytics.summary.requests >= 3, "analytics did not survive the restart");

    const list = await getJson(providerPaths.list, ProviderListSchema, 200, second.origin);

    assert.equal(
      list.providers.filter((provider) => provider.origin === "builtin").length,
      1,
      "the built-in Kilo Code provider was seeded twice",
    );
  });
} finally {
  await second.stop();
  await upstream.stop(true);
  await kilocode.stop(true);
  rmSync(workDir, { recursive: true, force: true });
}

if (process.env.BANDAR_SMOKE_DEBUG === "1") {
  console.log(first.log());
  console.log(second.log());
}

if (failures > 0) {
  console.error(`smoke failed: ${failures} check(s)`);
  process.exit(1);
}

console.log("smoke ok");

function chat(model: string, stream: boolean, tag: string): Json {
  return {
    model,
    stream,
    messages: [{ role: "user", content: `hello from ${tag}` }],
    temperature: 0.1,
  };
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function boot(port = 0): Promise<Booted> {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing; run \`bun run build\` first`);

  const proc = Bun.spawn([BINARY], {
    env: {
      ...Bun.env,
      BANDAR_PORT: String(port),
      BANDAR_DB: dbPath,
      BANDAR_DUCKDB: duckPath,
      BANDAR_AUTH_SECRET: AUTH_SECRET,
      BANDAR_KILOCODE_API: kilocodeOrigin,
      BANDAR_KILOCODE_MODELS_URL: `${kilocodeOrigin}/api/gateway/models`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let log = "";
  const stderr = Bun.readableStreamToText(proc.stderr).catch(() => "");

  void (async () => {
    const reader = proc.stdout.getReader();

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      log += decoder.decode(value, { stream: true });
    }
  })();

  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const found = log.match(/listening on (http:\/\/\S+)/)?.[1];

    if (found) return { origin: found, log: () => log, stop: () => stop(proc) };

    if (proc.exitCode !== null)
      throw new Error(`the binary exited with ${proc.exitCode}\n${await stderr}`);
    await Bun.sleep(25);
  }

  proc.kill();
  throw new Error(`the binary never reported a port\n${await stderr}`);
}

async function stop(proc: Bun.Subprocess): Promise<void> {
  proc.kill();
  await proc.exited;
}

async function getJson<T>(
  path: string,
  schema: v.GenericSchema<T>,
  status: number,
  base: string = origin,
): Promise<T> {
  const response = await fetch(new URL(path, base), { headers: sessionHeaders() });
  assert.equal(response.status, status);

  return v.parse(schema, await response.json());
}

async function postJson<T>(
  path: string,
  body: Json,
  schema: v.GenericSchema<T>,
  status: number,
): Promise<T> {
  const response = await post(path, body);

  if (response.status !== status) {
    throw new Error(`POST ${path} returned ${response.status}: ${await response.clone().text()}`);
  }

  return v.parse(schema, await response.json());
}

async function post(
  path: string,
  body: Json,
  headers: Readonly<Record<string, string>> = {},
  base: string = origin,
): Promise<Response> {
  return fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", ...sessionHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}

async function put(
  path: string,
  body: Json,
  headers: Readonly<Record<string, string>> = {},
  base: string = origin,
): Promise<Response> {
  return fetch(new URL(path, base), {
    method: "PUT",
    headers: { "content-type": "application/json", ...sessionHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}

async function putJson<T>(
  path: string,
  body: Json,
  schema: v.GenericSchema<T>,
  status: number,
): Promise<T> {
  const response = await put(path, body);

  if (response.status !== status) {
    throw new Error(`PUT ${path} returned ${response.status}: ${await response.clone().text()}`);
  }

  return v.parse(schema, await response.json());
}

function chatRequest(model: string, stream: boolean): Promise<Response> {
  return fetch(new URL("/v1/chat/completions", origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer() },
    body: JSON.stringify(chat(model, stream, "reference")),
  });
}

async function referenceRows(reference: string): Promise<readonly RequestEvent[]> {
  const list = await getJson(`${analyticsPaths.requests}?limit=20`, RequestListSchema, 200);

  return list.requests.filter((request) => request.reference === reference);
}

async function waitForRequests(
  reference: string,
  done: (requests: readonly RequestEvent[]) => boolean,
  what: string,
): Promise<readonly RequestEvent[]> {
  const deadline = Date.now() + 3000;

  for (;;) {
    const requests = await referenceRows(reference);

    if (done(requests)) return requests;

    if (Date.now() > deadline) throw new Error(`${what} never appeared for ${reference}`);

    await Bun.sleep(25);
  }
}

async function mintGatewayKey(): Promise<string> {
  const response = await post(
    "/api/auth/api-key/create",
    { name: "smoke key" },
    { origin: requestOrigin },
  );

  assert.equal(response.status, 200);

  const minted = v.parse(CreatedApiKeySchema, await response.json());

  apiKey = minted.key;
  keyId = minted.id;

  return minted.key;
}

async function deleteJson<T>(
  path: string,
  schema: v.GenericSchema<T>,
  base: string = origin,
): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: "DELETE",
    headers: sessionHeaders(),
  });

  if (response.status !== 200) {
    console.error("deleteJson", path, response.status, await response.text());

    throw new Error(`DELETE ${path} returned ${response.status}`);
  }

  return v.parse(schema, await response.json());
}

type ProviderSlot = { provider: Provider | null; modelId: string };

async function errorBody(
  response: Response,
): Promise<v.InferOutput<typeof ApiErrorBodySchema>["error"]> {
  return v.parse(ApiErrorBodySchema, await response.json()).error;
}

async function openAiError(
  response: Response,
): Promise<v.InferOutput<typeof OpenAiErrorSchema>["error"]> {
  return v.parse(OpenAiErrorSchema, await response.json()).error;
}

function sessionHeaders(): Record<string, string> {
  return cookie === "" ? {} : { cookie };
}

function bearer() {
  return { authorization: `Bearer ${apiKey}`, cookie: "" };
}

function keyHeaders() {
  return { [API_KEY_HEADER]: apiKey, cookie: "" };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("better-auth.session_token="));

  assert.ok(setCookie, "the response set no better-auth.session_token cookie");

  const pair = setCookie.split(";")[0];
  assert.ok(pair);

  return pair;
}

function originHeader(base: string): string {
  return `http://localhost:${new URL(base).port}`;
}

function contentType(response: Response): string {
  return response.headers.get("content-type") ?? "";
}

async function readStream(response: Response): Promise<{
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  done: boolean;
}> {
  const raw = await response.text();
  let text = "";
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

  for (const event of raw.split("\n\n")) {
    if (!event.startsWith("data: ")) continue;

    const data = event.slice("data: ".length);

    if (data === "[DONE]") continue;

    const parsed = v.safeParse(StreamChunkSchema, JSON.parse(data));

    if (!parsed.success) continue;

    for (const choice of parsed.output.choices ?? []) text += choice.delta.content ?? "";

    if (parsed.output.usage !== undefined) {
      usage = {
        prompt_tokens: parsed.output.usage.prompt_tokens,
        completion_tokens: parsed.output.usage.completion_tokens,
      };
    }
  }

  return { text, usage, done: raw.includes("data: [DONE]") };
}

async function waitForAnalytics(minRequests: number): Promise<Analytics> {
  const deadline = Date.now() + 3000;

  for (;;) {
    const analytics = await getJson(`${analyticsPaths.analytics}?days=30`, AnalyticsSchema, 200);

    if (analytics.summary.requests >= minRequests || Date.now() > deadline) return analytics;

    await Bun.sleep(25);
  }
}

function reservePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;

  return probe.stop().then(() => {
    if (port === undefined) throw new Error("Bun.serve reported no port");

    return port;
  });
}

function lastJournalTag(): string {
  // SAFETY: drizzle-kit wrote this journal; only entries[].idx and entries[].tag are read.
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as Journal;
  const last = [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1);

  if (!last) throw new Error(`${JOURNAL} has no migration entries`);

  return last.tag;
}

function lastDuckTag(): string {
  const names = readdirSync(DUCK_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .at(-1);

  if (!names) throw new Error(`${DUCK_DIR} has no migrations`);

  return names.slice(0, -4);
}

function startUpstream() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = v.safeParse(v.object({ stream: v.optional(v.boolean()) }), await request.json());
      const stream = body.success ? (body.output.stream ?? false) : false;

      if (url.pathname === "/openai/chat/completions") {
        if (request.headers.get("authorization") !== "Bearer openai-key") {
          return jsonError(401, "bad openai key");
        }

        if (!stream) {
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: "Hello from OpenAI" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          });
        }

        return sse([
          { choices: [{ delta: { role: "assistant", content: "Hello" } }] },
          { choices: [{ delta: { content: " from OpenAI" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          },
          "[DONE]",
        ]);
      }

      if (url.pathname === "/anthropic/messages") {
        if (request.headers.get("x-api-key") !== "anthropic-key") {
          return jsonError(401, "bad anthropic key");
        }

        if (!stream) {
          return Response.json({
            content: [{ type: "text", text: "Hello from Anthropic" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 9, output_tokens: 5 },
          });
        }

        return sse([
          { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: " from Anthropic" } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]);
      }

      if (url.pathname.includes("/google/models/")) {
        if (request.headers.get("x-goog-api-key") !== "google-key") {
          return jsonError(401, "bad google key");
        }

        const isStream = url.pathname.endsWith(":streamGenerateContent");

        if (!isStream) {
          return Response.json({
            candidates: [
              {
                content: { parts: [{ text: "Hello from Google" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
          });
        }

        return sse([
          { candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
          {
            candidates: [{ content: { parts: [{ text: " from Google" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
          },
        ]);
      }

      return jsonError(404, `no fake upstream for ${url.pathname}`);
    },
  });
}

function startKilocode() {
  let polls = 0;

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/openrouter/chat/completions") {
        if (request.headers.get("authorization") !== "Bearer kilo-device-token") {
          return jsonError(401, "bad kilo connection");
        }

        if (request.headers.get("x-kilocode-organizationid") !== "org-smoke") {
          return jsonError(401, "missing kilo organization");
        }

        const body = v.safeParse(
          v.object({ stream: v.optional(v.boolean()) }),
          await request.json(),
        );

        const stream = body.success ? (body.output.stream ?? false) : false;

        if (!stream) {
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: "Hello from Kilo" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          });
        }

        return sse([
          { choices: [{ delta: { content: "Hello" } }] },
          {
            choices: [{ delta: { content: " from Kilo" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          },
          "[DONE]",
        ]);
      }

      if (url.pathname === "/api/device-auth/codes" && request.method === "POST") {
        return Response.json({
          code: "device-code-smoke",
          user_code: "SMOK-CODE",
          verificationUrl: "https://app.kilo.ai/device-auth?code=SMOK-CODE",
          expiresIn: 600,
        });
      }

      if (url.pathname === "/api/device-auth/codes/device-code-smoke") {
        polls += 1;

        if (polls === 1) return Response.json({ status: "pending" }, { status: 202 });

        return Response.json({ status: "approved", token: "kilo-device-token" });
      }

      if (url.pathname === "/api/profile") {
        return Response.json({ organizations: [{ id: "org-smoke" }] });
      }

      if (url.pathname === "/api/gateway/models") {
        return Response.json({
          data: [
            {
              id: "anthropic/claude-sonnet-4",
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            {
              id: "anthropic/claude-sonnet-4:free",
              pricing: { prompt: "0", completion: "0" },
            },
            { id: "kilo-auto/free", pricing: { prompt: "0", completion: "0" } },
            { id: "openai/gpt-5-codex", pricing: { prompt: "-1", completion: "-1" } },
            // `fast` is already an alias on the OpenAI provider, so this one is skipped.
            { id: "fast", pricing: { prompt: "0.000001", completion: "0.000002" } },
          ],
        });
      }

      return jsonError(404, `no fake kilo route for ${url.pathname}`);
    },
  });
}

function sse(events: readonly Json[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const event of events) {
          await Bun.sleep(30);
          const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }

        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}
