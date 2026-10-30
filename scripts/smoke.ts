import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import * as v from "valibot";
import { BINARY } from "./binary";
import {
  AnalyticsSchema,
  ProjectListSchema,
  RequestListSchema,
  SessionListSchema,
  analyticsPaths,
  type Analytics,
  type RequestEvent,
} from "../src/shared/analytics";
import {
  ApiErrorBodySchema,
  BackupManifestSchema,
  HealthSchema,
  apiPaths,
} from "../src/shared/api";
import { API_KEY_HEADER, CreatedApiKeySchema } from "../src/shared/api-keys";
import { AuthResultSchema } from "../src/shared/auth";
import { CooldownListSchema, cooldownPaths } from "../src/shared/cooldowns";
import {
  ProviderCredentialProbeSchema,
  ProviderDetailSchema,
  ProviderListSchema,
  ProviderModelRefreshSchema,
  ProviderOAuthPollSchema,
  ProviderOAuthStartSchema,
  ProviderSchema,
  providerPaths,
  type Provider,
  type ProviderModel,
  type ProviderModelEditInput,
} from "../src/shared/providers";
import { CHARS_PER_TOKEN } from "../src/server/router/anthropic-wire";
import { PROJECT_URL_HEADER } from "../src/shared/project";
import { SESSION_ID_HEADER } from "../src/shared/session-id";
import { TagListSchema, tagPaths } from "../src/shared/tags";

const JOURNAL = join(import.meta.dir, "../drizzle/meta/_journal.json");
const DUCK_DIR = join(import.meta.dir, "../duckdb");
const AUTH_SECRET = "smoke-secret-0123456789abcdef0123456789abcdef";

// A freshly compiled binary is cold: the first spawn pays for its image load and, on Windows, for
// a malware scan of the file, so the first boot gets a wider budget than the warm ones.
const FIRST_BOOT_TIMEOUT_MS = 45_000;
const BOOT_TIMEOUT_MS = 15_000;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type Journal = { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };

type Booted = {
  readonly origin: string;
  readonly log: () => string;
  readonly errors: () => string;
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

const MessageSchema = v.object({
  type: v.literal("message"),
  role: v.literal("assistant"),
  model: v.string(),
  content: v.array(v.object({ type: v.literal("text"), text: v.string() })),
  stop_reason: v.string(),
  usage: v.object({ input_tokens: v.number(), output_tokens: v.number() }),
});

const MessageErrorSchema = v.object({
  type: v.literal("error"),
  error: v.object({ type: v.string(), message: v.string() }),
});

const TokenCountSchema = v.object({ input_tokens: v.number() });

const MessageEventSchema = v.object({
  type: v.string(),
  delta: v.optional(
    v.object({
      type: v.optional(v.string()),
      text: v.optional(v.nullable(v.string())),
      stop_reason: v.optional(v.nullable(v.string())),
    }),
  ),
  usage: v.optional(
    v.object({
      input_tokens: v.optional(v.number()),
      output_tokens: v.optional(v.number()),
    }),
  ),
});

const UpstreamChatSchema = v.object({
  messages: v.array(v.object({ role: v.string(), content: v.string() })),
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

const ResponsesBodySchema = v.strictObject({
  model: v.string(),
  input: v.array(
    v.object({
      role: v.picklist(["system", "user", "assistant"]),
      content: v.array(v.object({ type: v.literal("input_text"), text: v.string() })),
    }),
  ),
  stream: v.optional(v.boolean()),
  max_output_tokens: v.optional(v.number()),
  temperature: v.optional(v.number()),
  top_p: v.optional(v.number()),
});

const expectedMigration = lastJournalTag();
const expectedDuckMigration = lastDuckTag();
const workDir = mkdtempSync(join(tmpdir(), "bandar-smoke-"));
const homeDir = join(workDir, "home");
const dbPath = join(homeDir, "bandar.db");
const authEmail = `${Date.now()}@smoke.test`;
const authPassword = "smoke-password-1";

const upstreamChats: v.InferOutput<typeof UpstreamChatSchema>[] = [];
const upstream = startUpstream();
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
const kilocode = startKilocode();
const kilocodeOrigin = `http://127.0.0.1:${kilocode.port}`;

type NousState = {
  deviceStarts: number;
  polls: number;
  refreshToken: string;
  presented: string[];
};

const nousState: NousState = { deviceStarts: 0, polls: 0, refreshToken: "rt-1", presented: [] };
const opencodeState = { requests: 0 };
const builtIns = startBuiltIns();
const builtInsOrigin = `http://127.0.0.1:${builtIns.port}`;

let failures = 0;
let cookie = "";
let openaiProvider: ProviderSlot = { provider: null, modelId: "" };
let claudeProvider: ProviderSlot = { provider: null, modelId: "" };
const kiloProvider: ProviderSlot = { provider: null, modelId: "" };
const tokenharborProvider: ProviderSlot = { provider: null, modelId: "" };
const yetaProvider: ProviderSlot = { provider: null, modelId: "" };
const riverProvider: ProviderSlot = { provider: null, modelId: "" };
const nousProvider: ProviderSlot = { provider: null, modelId: "" };
const hyperProvider: ProviderSlot = { provider: null, modelId: "" };
const opencodeProvider: ProviderSlot = { provider: null, modelId: "" };
const zroProvider: ProviderSlot = { provider: null, modelId: "" };
const wireProvider: ProviderSlot = { provider: null, modelId: "" };
let apiKey = "";
let overrideModelId = "";
let keyId = "";

const first = await boot(await reservePort(), FIRST_BOOT_TIMEOUT_MS);
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

  await check("GET /api/providers seeds every built-in provider", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const builtIn = list.providers.filter((provider) => provider.origin === "builtin");

    assert.deepEqual(
      builtIn.map((provider) => provider.kind),
      ["kilocode", "tokenharbor", "yeta", "river", "nous", "hyper", "opencode", "zro"],
    );

    const byKind = new Map(builtIn.map((provider) => [provider.kind, provider]));
    const kilo = byKind.get("kilocode");

    if (kilo === undefined) throw new Error("the built-in Kilo Code provider is missing");

    assert.equal(kilo.name, "Kilo Code");
    assert.equal(kilo.slug, "kilo");
    assert.equal(kilo.baseUrl, `${kilocodeOrigin}/api/openrouter`);
    assert.deepEqual(kilo.authModes, ["api-key", "oauth"]);
    assert.equal(kilo.hasCatalog, true);
    assert.deepEqual(kilo.credentials, []);
    assert.deepEqual(kilo.models, []);

    const harbor = byKind.get("tokenharbor");

    if (harbor === undefined) throw new Error("the built-in Token Harbor provider is missing");

    assert.equal(harbor.name, "Token Harbor");
    assert.equal(harbor.slug, "tokenharbor");
    assert.equal(harbor.baseUrl, `${builtInsOrigin}/tokenharbor/v1`);
    assert.deepEqual(harbor.authModes, ["api-key"]);
    assert.equal(harbor.hasCatalog, true);

    const yeta = byKind.get("yeta");

    if (yeta === undefined) throw new Error("the built-in Yeta provider is missing");

    assert.equal(yeta.name, "Yeta");
    assert.equal(yeta.slug, "yeta");
    assert.equal(yeta.baseUrl, `${builtInsOrigin}/yeta/v1`);
    assert.deepEqual(yeta.authModes, ["api-key"]);
    assert.equal(yeta.hasCatalog, true);

    const river = byKind.get("river");

    if (river === undefined) throw new Error("the built-in River provider is missing");

    assert.equal(river.name, "River");
    assert.equal(river.slug, "river");
    assert.equal(river.baseUrl, `${builtInsOrigin}/river/v1`);
    assert.deepEqual(river.authModes, ["api-key"]);
    assert.equal(river.hasCatalog, true);

    const nous = byKind.get("nous");

    if (nous === undefined) throw new Error("the built-in Nous Portal provider is missing");

    assert.equal(nous.name, "Nous Portal");
    assert.equal(nous.slug, "nous");
    assert.equal(nous.baseUrl, `${builtInsOrigin}/nous/v1`);
    assert.deepEqual(nous.authModes, ["oauth"]);
    assert.equal(nous.hasCatalog, true);

    const hyper = byKind.get("hyper");

    if (hyper === undefined) throw new Error("the built-in Hyper provider is missing");

    assert.equal(hyper.name, "Hyper");
    assert.equal(hyper.slug, "hyper");
    assert.equal(hyper.baseUrl, `${builtInsOrigin}/hyper/v1`);
    assert.deepEqual(hyper.authModes, ["api-key"]);
    assert.equal(hyper.hasCatalog, true);

    const opencode = byKind.get("opencode");

    if (opencode === undefined) throw new Error("the built-in OpenCode Go provider is missing");

    assert.equal(opencode.name, "OpenCode Go");
    assert.equal(opencode.slug, "opencode");
    assert.equal(opencode.baseUrl, `${builtInsOrigin}/opencode/inference`);
    assert.deepEqual(opencode.authModes, ["api-key"]);
    assert.equal(opencode.hasCatalog, true);

    const zro = byKind.get("zro");

    if (zro === undefined) throw new Error("the built-in Zro provider is missing");

    assert.equal(zro.name, "Zro");
    assert.equal(zro.slug, "zro");
    assert.equal(zro.baseUrl, `${builtInsOrigin}/zro/v1`);
    assert.deepEqual(zro.authModes, ["api-key"]);
    assert.deepEqual(zro.compats, ["chat", "messages"]);
    assert.equal(zro.hasCatalog, true);

    kiloProvider.provider = kilo;
    tokenharborProvider.provider = harbor;
    yetaProvider.provider = yeta;
    riverProvider.provider = river;
    nousProvider.provider = nous;
    hyperProvider.provider = hyper;
    opencodeProvider.provider = opencode;
    zroProvider.provider = zro;
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

  await check("POST /api/providers/:id/models adds an address to a provider", async () => {
    const provider = await postJson(
      providerPaths.models(openaiProvider.provider?.id ?? ""),
      { upstreamModel: "fake-openai-model", slug: "fast" },
      ProviderSchema,
      201,
    );

    openaiProvider.provider = provider;
    openaiProvider.modelId = provider.models[0]?.id ?? "";

    assert.deepEqual(
      provider.models.map((model) => [model.slug, model.alias, model.upstreamModel]),
      [["fast", null, "fake-openai-model"]],
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
      { upstreamModel: "fake-claude", slug: "claude" },
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
      { upstreamModel: "fake-gemini", slug: "gemini" },
      ProviderSchema,
      201,
    );
  });

  await check("GET /api/providers lists three custom providers and every built-in", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const custom = list.providers.filter((provider) => provider.origin === "custom");
    const builtIn = list.providers.filter((provider) => provider.origin === "builtin");

    assert.equal(custom.length, 3);
    assert.equal(builtIn.length, 8);
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

  await check("POST /api/providers/:id/models rejects a duplicate address with 409", async () => {
    const response = await post(providerPaths.models(claudeProvider.provider?.id ?? ""), {
      upstreamModel: "other-model",
      slug: "fast",
    });

    assert.equal(response.status, 409);

    const error = await errorBody(response);

    assert.equal(error.code, "conflict");
    assert.equal(error.message, "the address fast is taken");

    const duplicateUpstream = await post(providerPaths.models(openaiProvider.provider?.id ?? ""), {
      upstreamModel: "fake-openai-model",
      slug: "fast-2",
    });

    assert.equal(duplicateUpstream.status, 409);
    assert.equal((await errorBody(duplicateUpstream)).code, "conflict");
  });

  await check(
    "DELETE /api/providers/:id/models/:modelId removes a model and its address",
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
        `addresses after the removal: ${body.data.map((model) => model.id).join(", ")}`,
      );

      const restored = await postJson(
        providerPaths.models(claudeProvider.provider?.id ?? ""),
        { upstreamModel: "fake-claude", slug: "claude" },
        ProviderSchema,
        201,
      );

      claudeProvider.modelId = restored.models[0]?.id ?? "";
    },
  );

  await check("two models may share a label", async () => {
    const provider = await postJson(
      providerPaths.models(claudeProvider.provider?.id ?? ""),
      { upstreamModel: "other-model", alias: "fast" },
      ProviderSchema,
      201,
    );

    const shared = provider.models.find((model) => model.upstreamModel === "other-model");

    assert.equal(shared?.slug, "fake-anthropic/other-model");
    assert.equal(shared?.alias, "fast");

    const listed = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await listed.json());

    assert.equal(models.data.filter((model) => model.id === "fast").length, 1);

    await deleteJson(
      providerPaths.model(claudeProvider.provider?.id ?? "", shared?.id ?? ""),
      ProviderSchema,
    );
  });

  await check("POST /api/auth/api-key/create mints a gateway key", async () => {
    const minted = await mintGatewayKey();

    assert.ok(minted.startsWith("bandar_"), `key ${minted} lacks the bandar_ prefix`);
  });

  await check("GET /v1/models lists addresses and provider refs", async () => {
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

  await check("an unknown address is a 404 model_not_found", async () => {
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

    const allProviders = await getJson(
      `${analyticsPaths.requests}?limit=10&providerId=`,
      RequestListSchema,
      200,
    );

    assert.ok(
      allProviders.requests.length > requests.requests.length,
      "a blank provider filter still narrowed the list",
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
  await check("GET /api/analytics filters by the project url header", async () => {
    const before = await getJson(`${analyticsPaths.analytics}?days=30`, AnalyticsSchema, 200);

    const tagged = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROJECT_URL_HEADER]: "https://Example.com/app/?utm_source=smoke#top",
        ...bearer(),
      },
      body: JSON.stringify(chat("fast", false, "project")),
    });

    assert.equal(tagged.status, 200);

    const untagged = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROJECT_URL_HEADER]: "not a url",
        ...bearer(),
      },
      body: JSON.stringify(chat("fast", false, "garbage")),
    });

    assert.equal(untagged.status, 200);

    const projects = await getJson(analyticsPaths.projects, ProjectListSchema, 200);

    assert.deepEqual(projects, { projects: ["https://example.com/app"] });

    const after = await getJson(`${analyticsPaths.analytics}?days=30`, AnalyticsSchema, 200);

    assert.equal(after.summary.requests, before.summary.requests + 2);

    const filtered = await getJson(
      `${analyticsPaths.analytics}?days=30&projectUrl=${encodeURIComponent("https://example.com/app")}`,
      AnalyticsSchema,
      200,
    );

    assert.equal(filtered.summary.requests, 1);

    const rejected = await fetch(
      new URL(`${analyticsPaths.analytics}?days=30&projectUrl=not-a-url`, origin),
      { headers: sessionHeaders() },
    );

    assert.equal(rejected.status, 422);

    const blank = await getJson(
      `${analyticsPaths.analytics}?days=30&projectUrl=`,
      AnalyticsSchema,
      200,
    );

    assert.equal(blank.summary.requests, after.summary.requests);
  });

  await check("GET /api/analytics filters by the session id header", async () => {
    const before = await getJson(`${analyticsPaths.analytics}?days=30`, AnalyticsSchema, 200);

    const tagged = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_ID_HEADER]: "session-alpha",
        ...bearer(),
      },
      body: JSON.stringify(chat("fast", false, "session")),
    });

    assert.equal(tagged.status, 200);

    const untagged = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_ID_HEADER]: "has space",
        ...bearer(),
      },
      body: JSON.stringify(chat("fast", false, "unusable session")),
    });

    assert.equal(untagged.status, 200);

    const sessions = await getJson(analyticsPaths.sessions, SessionListSchema, 200);

    assert.ok(sessions.sessions.includes("session-alpha"), "the list is missing the tagged id");
    assert.ok(!sessions.sessions.includes("has space"), "the list kept the rejected value");

    const after = await getJson(`${analyticsPaths.analytics}?days=30`, AnalyticsSchema, 200);

    assert.equal(after.summary.requests, before.summary.requests + 2);

    const filtered = await getJson(
      `${analyticsPaths.analytics}?days=30&sessionId=session-alpha`,
      AnalyticsSchema,
      200,
    );

    assert.equal(filtered.summary.requests, 1);

    const rejected = await fetch(
      new URL(`${analyticsPaths.analytics}?days=30&sessionId=has%20space`, origin),
      { headers: sessionHeaders() },
    );

    assert.equal(rejected.status, 422);
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
    assert.equal(openaiProvider.provider?.hasCatalog, false);
  });

  await check("POST /api/providers/:id/models/refresh imports the catalog once", async () => {
    const id = kiloProvider.provider?.id ?? "";

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 5);
    assert.equal(refresh.skipped, 0);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    const imported = [...detail.provider.models].sort((left, right) =>
      left.slug < right.slug ? -1 : 1,
    );

    assert.deepEqual(
      imported.map((model) => [model.slug, model.alias]),
      [
        ["kilo/anthropic/claude-sonnet-4", null],
        ["kilo/anthropic/claude-sonnet-4:free", "anthropic/claude-sonnet-4"],
        ["kilo/fast", null],
        ["kilo/kilo-auto/free", null],
        ["kilo/openai/gpt-5-codex", null],
      ],
    );

    const sonnet = detail.provider.models.find(
      (model) => model.slug === "kilo/anthropic/claude-sonnet-4",
    );

    const free = detail.provider.models.find((model) => model.slug === "kilo/kilo-auto/free");

    const auto = detail.provider.models.find((model) => model.slug === "kilo/openai/gpt-5-codex");

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
      body: JSON.stringify(chat("kilo/anthropic/claude-sonnet-4", true, "kilocode")),
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
      body: JSON.stringify(chat("kilo/openai/gpt-5-codex", false, "kilocode")),
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

  await check("a keyed catalog refuses to import without a key", async () => {
    const id = tokenharborProvider.provider?.id ?? "";

    const refused = await post(providerPaths.refreshModels(id), {});

    assert.equal(refused.status, 400);
    assert.equal((await errorBody(refused)).code, "upstream_invalid_request");
  });

  await check("Token Harbor imports its keyed catalog and answers chat", async () => {
    const id = tokenharborProvider.provider?.id ?? "";

    await postJson(providerPaths.credentials(id), { apiKey: "thk_test" }, ProviderSchema, 201);

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 2);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.deepEqual(detail.provider.models.map((model) => model.upstreamModel).sort(), [
      "thk-mini",
      "thk-pro",
    ]);
    assert.ok(
      detail.provider.models.every(
        (model) => model.inputPricePerMtok === null && model.outputPricePerMtok === null,
      ),
      "Token Harbor publishes no prices",
    );

    const response = await chatRequest("tokenharbor/thk-pro", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from Token Harbor");
    assert.equal(body.usage?.prompt_tokens, 5);
    assert.equal(body.usage?.completion_tokens, 2);
  });

  await check("Yeta joins its pricing ratios and streams chat", async () => {
    const id = yetaProvider.provider?.id ?? "";

    await postJson(providerPaths.credentials(id), { apiKey: "yeta_test" }, ProviderSchema, 201);

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 2);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);
    const large = detail.provider.models.find((model) => model.upstreamModel === "yeta-large");
    const image = detail.provider.models.find((model) => model.upstreamModel === "yeta-image");

    assert.equal(large?.inputPricePerMtok, 3);
    assert.equal(large?.outputPricePerMtok, 12);
    assert.equal(image?.inputPricePerMtok, null);
    assert.equal(image?.outputPricePerMtok, null);

    const response = await chatRequest("yeta/yeta-large", true);

    assert.equal(response.status, 200);

    const stream = await readStream(response);

    assert.equal(stream.text, "Hello from Yeta");
    assert.equal(stream.usage?.prompt_tokens, 7);
    assert.equal(stream.usage?.completion_tokens, 3);
    assert.equal(stream.done, true);
  });

  await check("River imports its public pricing list and answers chat", async () => {
    const id = riverProvider.provider?.id ?? "";

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 2);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);
    const flow = detail.provider.models.find((model) => model.upstreamModel === "river-flow");

    assert.equal(flow?.inputPricePerMtok, 0.4);
    assert.equal(flow?.outputPricePerMtok, 1.6);

    await postJson(providerPaths.credentials(id), { apiKey: "rv_test" }, ProviderSchema, 201);

    const response = await chatRequest("river/river-flow", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from River");
    assert.equal(body.usage?.prompt_tokens, 4);
    assert.equal(body.usage?.completion_tokens, 3);
  });

  await check("Hyper imports its public catalog before a key and answers chat", async () => {
    const id = hyperProvider.provider?.id ?? "";

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 3);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.deepEqual(detail.provider.credentials, []);
    assert.deepEqual(detail.provider.models.map((model) => model.upstreamModel).sort(), [
      "hyper-noted",
      "hyper-prism",
      "hyper-unpriced",
    ]);

    const prism = detail.provider.models.find((model) => model.upstreamModel === "hyper-prism");
    const noted = detail.provider.models.find((model) => model.upstreamModel === "hyper-noted");

    const unpriced = detail.provider.models.find(
      (model) => model.upstreamModel === "hyper-unpriced",
    );

    assert.equal(prism?.inputPricePerMtok, 2.5);
    assert.equal(prism?.outputPricePerMtok, 6);
    assert.equal(noted?.inputPricePerMtok, 0.834);
    assert.equal(noted?.outputPricePerMtok, 2.501);
    assert.equal(unpriced?.inputPricePerMtok, null);
    assert.equal(unpriced?.outputPricePerMtok, null);

    await postJson(providerPaths.credentials(id), { apiKey: "hyper_test" }, ProviderSchema, 201);

    const response = await chatRequest("hyper/hyper-prism", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from Hyper");
    assert.equal(body.usage?.prompt_tokens, 3);
    assert.equal(body.usage?.completion_tokens, 4);
  });

  await check("OpenCode Go imports its catalog before a key and drops the dark ids", async () => {
    const id = opencodeProvider.provider?.id ?? "";

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 4);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.deepEqual(detail.provider.credentials, []);
    assert.deepEqual(detail.provider.models.map((model) => model.upstreamModel).sort(), [
      "claude-haiku-5-5",
      "gemini-4-argon",
      "glm-5.3",
      "gpt-6-luna",
    ]);

    const glm = detail.provider.models.find((model) => model.upstreamModel === "glm-5.3");
    const gemini = detail.provider.models.find((model) => model.upstreamModel === "gemini-4-argon");
    const luna = detail.provider.models.find((model) => model.upstreamModel === "gpt-6-luna");

    assert.equal(glm?.inputPricePerMtok, 1.4);
    assert.equal(glm?.outputPricePerMtok, 4.4);
    assert.equal(gemini?.inputPricePerMtok, null);
    assert.equal(gemini?.outputPricePerMtok, null);
    assert.equal(luna?.inputPricePerMtok, null);
    assert.equal(luna?.outputPricePerMtok, null);
  });

  await check("OpenCode Go answers chat on each wire with one bearer", async () => {
    const id = opencodeProvider.provider?.id ?? "";

    await postJson(providerPaths.credentials(id), { apiKey: "opencode_test" }, ProviderSchema, 201);

    const openai = await chatRequest("opencode/glm-5.3", false);

    assert.equal(openai.status, 200);
    assert.equal(
      v.parse(CompletionSchema, await openai.json()).choices[0]?.message.content,
      "Hello from OpenCode OpenAI",
    );

    const anthropic = await chatRequest("opencode/claude-haiku-5-5", false);

    assert.equal(anthropic.status, 200);

    const anthropicBody = v.parse(CompletionSchema, await anthropic.json());

    assert.equal(anthropicBody.choices[0]?.message.content, "Hello from OpenCode Anthropic");
    assert.equal(anthropicBody.usage?.prompt_tokens, 5);
    assert.equal(anthropicBody.usage?.completion_tokens, 3);

    const google = await chatRequest("opencode/gemini-4-argon", false);

    assert.equal(google.status, 200);
    assert.equal(
      v.parse(CompletionSchema, await google.json()).choices[0]?.message.content,
      "Hello from OpenCode Google",
    );

    const anthropicStream = await chatRequest("opencode/claude-haiku-5-5", true);

    assert.equal(anthropicStream.status, 200);

    const anthropicEvents = await readStream(anthropicStream);

    assert.equal(anthropicEvents.text, "Hello from OpenCode Anthropic");
    assert.equal(anthropicEvents.usage?.prompt_tokens, 5);
    assert.equal(anthropicEvents.usage?.completion_tokens, 3);

    const googleStream = await chatRequest("opencode/gemini-4-argon", true);

    assert.equal(googleStream.status, 200);

    const googleEvents = await readStream(googleStream);

    assert.equal(googleEvents.text, "Hello from OpenCode Google");
    assert.equal(googleEvents.usage?.prompt_tokens, 4);
    assert.equal(googleEvents.usage?.completion_tokens, 2);

    const responses = await chatRequest("opencode/gpt-6-luna", false);

    assert.equal(responses.status, 200);

    const responsesBody = v.parse(CompletionSchema, await responses.json());

    assert.equal(responsesBody.choices[0]?.message.content, "Hello from OpenCode Responses");
    assert.equal(responsesBody.usage?.prompt_tokens, 7);
    assert.equal(responsesBody.usage?.completion_tokens, 3);

    const responsesStream = await chatRequest("opencode/gpt-6-luna", true);

    assert.equal(responsesStream.status, 200);

    const responsesEvents = await readStream(responsesStream);

    assert.equal(responsesEvents.text, "Hello from OpenCode Responses");
    assert.equal(responsesEvents.usage?.prompt_tokens, 7);
    assert.equal(responsesEvents.usage?.completion_tokens, 3);
  });

  await check("a hand-added responses model answers on the responses wire", async () => {
    const id = opencodeProvider.provider?.id ?? "";

    await postJson(
      providerPaths.models(id),
      { upstreamModel: "grok-4.7", slug: "grok-luna" },
      ProviderSchema,
      201,
    );

    const response = await chatRequest("grok-luna", false);

    assert.equal(response.status, 200);
    assert.equal(
      v.parse(CompletionSchema, await response.json()).choices[0]?.message.content,
      "Hello from OpenCode Responses",
    );
  });

  await check("an undocumented go model is a 400 before any request", async () => {
    const id = opencodeProvider.provider?.id ?? "";

    await postJson(
      providerPaths.models(id),
      { upstreamModel: "omen-alpha", slug: "omen-gap" },
      ProviderSchema,
      201,
    );

    const before = opencodeState.requests;
    const response = await chatRequest("omen-gap", false);

    assert.equal(response.status, 400);

    const error = await openAiError(response);

    assert.equal(error.code, "invalid_request");
    assert.match(error.message, /omen-alpha/);
    assert.equal(opencodeState.requests, before);
  });

  await check("Zro refuses a keyed import before a key", async () => {
    const id = zroProvider.provider?.id ?? "";

    const refused = await post(providerPaths.refreshModels(id), {});

    assert.equal(refused.status, 400);
    assert.equal((await errorBody(refused)).code, "upstream_invalid_request");
  });

  await check("Zro imports its listed ids at the table's prices", async () => {
    const id = zroProvider.provider?.id ?? "";

    await postJson(providerPaths.credentials(id), { apiKey: "zro_test" }, ProviderSchema, 201);

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 7);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);
    const models = detail.provider.models;

    assert.deepEqual(
      models.map((model) => model.slug).sort((left, right) => (left < right ? -1 : 1)),
      [
        "zro/deepseek-v4.1-flash",
        "zro/dolly1-security",
        "zro/glm-5.3-flash",
        "zro/minimax-m3.1-flash",
        "zro/zro-newcomer",
        "zro/zro/glm-5.3",
        "zro/zro/only-prefixed",
      ],
    );

    const twins = models.filter((model) => model.upstreamModel.endsWith("glm-5.3-flash"));

    assert.equal(twins.length, 1, "one model under two ids imported twice");
    assert.equal(twins[0]?.upstreamModel, "glm-5.3-flash");

    const twinless = models.find((model) => model.slug === "zro/zro/glm-5.3");
    const prefixed = models.find((model) => model.slug === "zro/zro/only-prefixed");

    assert.equal(twinless?.upstreamModel, "zro/glm-5.3");
    assert.equal(twinless?.inputPricePerMtok, 1.4);
    assert.equal(twinless?.cacheInputPricePerMtok, 0.3);
    assert.equal(twinless?.outputPricePerMtok, 4.2);
    assert.equal(prefixed?.upstreamModel, "zro/only-prefixed");
    assert.equal(prefixed?.inputPricePerMtok, null);

    const flash = models.find((model) => model.slug === "zro/glm-5.3-flash");
    const dolly = models.find((model) => model.slug === "zro/dolly1-security");
    const newcomer = models.find((model) => model.slug === "zro/zro-newcomer");

    assert.equal(flash?.inputPricePerMtok, 0.15);
    assert.equal(flash?.cacheInputPricePerMtok, 0.04);
    assert.equal(flash?.outputPricePerMtok, 0.5);
    assert.equal(dolly?.inputPricePerMtok, 0.45);
    assert.equal(dolly?.outputPricePerMtok, 1.5);
    assert.equal(newcomer?.inputPricePerMtok, null);
    assert.equal(newcomer?.outputPricePerMtok, null);
    assert.equal(newcomer?.defaultCompat, "chat");
    assert.ok(
      models.every((model) => model.slug !== "zro/dolly2-security"),
      "a tabled id the upstream omits imported anyway",
    );
  });

  await check("Zro answers chat on the chat wire", async () => {
    const response = await chatRequest("zro/deepseek-v4.1-flash", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from Zro");
    assert.equal(body.usage?.prompt_tokens, 6);
    assert.equal(body.usage?.completion_tokens, 2);
  });

  await check("a Zro model overridden to messages answers on the Anthropic wire", async () => {
    const id = zroProvider.provider?.id ?? "";
    const { provider } = await getJson(providerPaths.detail(id), ProviderDetailSchema, 200);
    const dolly = provider.models.find((model) => model.slug === "zro/dolly1-security");

    if (dolly === undefined) throw new Error("dolly1-security is not on Zro");

    const moved = await putModelEdit(id, dolly.id, { compat: "messages" });

    assert.equal(moved.models.find((model) => model.id === dolly.id)?.compat, "messages");

    const response = await chatRequest("zro/dolly1-security", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from Zro Messages");
    assert.equal(body.usage?.prompt_tokens, 5);
    assert.equal(body.usage?.completion_tokens, 4);
  });

  await check("a Zro chat stream carries text and usage", async () => {
    const response = await chatRequest("zro/glm-5.3-flash", true);

    assert.equal(response.status, 200);

    const stream = await readStream(response);

    assert.equal(stream.text, "Hello from Zro");
    assert.equal(stream.usage?.prompt_tokens, 6);
    assert.equal(stream.usage?.completion_tokens, 2);
    assert.equal(stream.done, true);
  });

  await check("the Nous Portal device login returns a code and connects", async () => {
    const id = nousProvider.provider?.id ?? "";

    const start = await postJson(providerPaths.oauthStart(id), {}, ProviderOAuthStartSchema, 200);

    assert.equal(start.userCode, "NOUS-CODE");
    assert.equal(
      start.verificationUrl,
      "https://portal.nousresearch.com/manage-subscription?code=NOUS-CODE",
    );
    assert.equal(start.expiresInSeconds, 600);
    assert.equal(start.intervalSeconds, 5);

    const pending = await postJson(providerPaths.oauthPoll(id), {}, ProviderOAuthPollSchema, 200);

    assert.equal(pending.state, "pending");

    const connected = await postJson(providerPaths.oauthPoll(id), {}, ProviderOAuthPollSchema, 200);

    assert.equal(connected.state, "connected");
    assert.equal(connected.authMode, "oauth");
  });

  await check("a device-login provider rejects an API key", async () => {
    const id = nousProvider.provider?.id ?? "";

    const single = await post(providerPaths.credentials(id), { apiKey: "nous-key" });

    assert.equal(single.status, 400);
    assert.equal((await errorBody(single)).code, "unsupported_mode");

    const bulk = await post(providerPaths.credentialsBulk(id), { apiKeys: ["nous-key"] });

    assert.equal(bulk.status, 400);
    assert.equal((await errorBody(bulk)).code, "unsupported_mode");

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.deepEqual(
      detail.provider.credentials.map((credential) => credential.authMode),
      ["oauth"],
    );
  });

  await check("the Nous Portal imports its public catalog with per-token prices", async () => {
    const id = nousProvider.provider?.id ?? "";

    const refresh = await postJson(
      providerPaths.refreshModels(id),
      {},
      ProviderModelRefreshSchema,
      200,
    );

    assert.equal(refresh.added, 2);

    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.deepEqual(detail.provider.models.map((model) => model.upstreamModel).sort(), [
      "nous-omni",
      "nous-text-large",
    ]);

    const large = detail.provider.models.find((model) => model.upstreamModel === "nous-text-large");
    const omni = detail.provider.models.find((model) => model.upstreamModel === "nous-omni");

    assert.equal(large?.inputPricePerMtok, 3);
    assert.equal(large?.outputPricePerMtok, 15);
    assert.equal(omni?.inputPricePerMtok, 1);
    assert.equal(omni?.outputPricePerMtok, 2);
  });

  await check("the Nous Portal answers chat with its oauth bearer", async () => {
    const response = await chatRequest("nous/nous-text-large", false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from Nous Portal");
    assert.equal(body.usage?.prompt_tokens, 6);
    assert.equal(body.usage?.completion_tokens, 5);
  });

  await check("two concurrent chats share one Nous renewal", async () => {
    const before = nousState.presented.length;

    const responses = await Promise.all([
      chatRequest("nous/nous-text-large", false),
      chatRequest("nous/nous-text-large", false),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(nousState.presented.length, before + 1);
  });

  await check("a renewed Nous token is rotated and persisted", async () => {
    const before = nousState.presented.length;
    const response = await chatRequest("nous/nous-text-large", false);

    assert.equal(response.status, 200);
    assert.equal(nousState.presented.length, before + 1);
    assert.equal(
      new Set(nousState.presented).size,
      nousState.presented.length,
      "the gateway presented a refresh token the portal had already spent",
    );
  });

  await check("a spent Nous refresh token is an auth failure", async () => {
    const spent = await fetch(new URL("/portal/api/oauth/token", builtInsOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-nous-refresh-token": "rt-1",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "hermes-cli",
      }).toString(),
    });

    assert.equal(spent.status, 400);
    assert.equal(
      v.parse(v.object({ error: v.string() }), await spent.json()).error,
      "invalid_grant",
    );

    nousState.refreshToken = "rt-elsewhere";

    const response = await chatRequest("nous/nous-text-large", false);

    assert.equal(response.status, 502);
    assert.equal((await openAiError(response)).code, "auth");
  });

  await check("a Nous credential with no refresh token is an auth failure", async () => {
    const id = nousProvider.provider?.id ?? "";
    const detail = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    for (const credential of detail.provider.credentials) {
      const removed = await fetch(new URL(providerPaths.credential(id, credential.id), origin), {
        method: "DELETE",
        headers: sessionHeaders(),
      });

      assert.equal(removed.status, 200);
    }

    await postJson(providerPaths.oauthStart(id), {}, ProviderOAuthStartSchema, 200);
    const connected = await postJson(providerPaths.oauthPoll(id), {}, ProviderOAuthPollSchema, 200);

    assert.equal(connected.state, "connected");

    const response = await chatRequest("nous/nous-text-large", false);

    assert.equal(response.status, 502);
    assert.equal((await openAiError(response)).code, "auth");
  });

  await check("a reconnect replaces the expiring Nous connection", async () => {
    const id = nousProvider.provider?.id ?? "";
    const before = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);
    const credentialId = before.provider.credentials[0]?.id ?? "";

    await postJson(providerPaths.oauthStart(id), {}, ProviderOAuthStartSchema, 200);
    const connected = await postJson(providerPaths.oauthPoll(id), {}, ProviderOAuthPollSchema, 200);

    assert.equal(connected.state, "connected");

    const after = await getJson(`${providerPaths.detail(id)}?days=30`, ProviderDetailSchema, 200);

    assert.equal(after.provider.credentials.length, 1);
    assert.equal(after.provider.credentials[0]?.id, credentialId);

    nousState.refreshToken = "rt-1";

    const response = await chatRequest("nous/nous-text-large", false);

    assert.equal(response.status, 200);
  });

  await check("providers carry derived slugs and model refs", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const byName = new Map(list.providers.map((provider) => [provider.name, provider]));

    assert.equal(byName.get("Fake OpenAI")?.slug, "fake-openai");
    assert.equal(byName.get("Fake Anthropic")?.slug, "fake-anthropic");
    assert.equal(byName.get("Fake Google")?.slug, "fake-google");
    assert.equal(byName.get("Kilo Code")?.slug, "kilo");

    const fast = byName.get("Fake OpenAI")?.models.find((model) => model.slug === "fast");

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

    assert.equal(rows.find((request) => request.status === "error")?.model, "dead/dead-model");
    assert.equal(rows.find((request) => request.status === "success")?.model, "fast");

    const deadDetail = await getJson(
      providerPaths.detail(dead.id) + "?days=30",
      ProviderDetailSchema,
      200,
    );

    const deadCredential = deadDetail.provider.credentials[0];

    assert.equal(deadCredential?.failures, 1);
    assert.ok(deadCredential?.flaggedUntil !== null, "the failing credential was not flagged");
    assert.equal(deadDetail.provider.failures, 0);

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

  await check("GET /api/cooldowns lists the failure that flagged a credential", async () => {
    const list = await getJson(cooldownPaths.list, CooldownListSchema, 200);

    const event = list.events.find(
      (entry) => entry.reference === "tags/failover" && entry.errorKind === "auth",
    );

    assert.ok(event, "no cooldown event for tags/failover");
    assert.equal(event.subject, "credential");
    assert.equal(event.providerName, "Dead");
    assert.equal(event.modelSlug, "dead/dead-model");
    assert.equal(event.credentialName, "");
    assert.equal(event.errorMessage, "bad openai key");
  });

  await check("GET /v1/models and GET /api/tags list the tag in priority order", async () => {
    const response = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await response.json());

    assert.ok(models.data.some((model) => model.id === "tags/failover"));

    const list = await getJson(tagPaths.list, TagListSchema, 200);
    const tag = list.tags.find((entry) => entry.slug === "failover");

    assert.equal(tag?.ref, "tags/failover");
    assert.deepEqual(
      tag?.models.map((model) => model.slug),
      ["fast", "dead/dead-model"],
      `failover order: ${tag?.models.map((model) => model.slug).join(", ")}`,
    );
  });

  await check("a streaming tag skips a model whose credential is cooling down", async () => {
    const list = await getJson(tagPaths.list, TagListSchema, 200);
    const tag = list.tags.find((entry) => entry.slug === "failover");

    if (tag === undefined) throw new Error("the failover tag is missing");

    const dead = tag.models.find((model) => model.upstreamModel === "dead-model");
    const fast = tag.models.find((model) => model.slug === "fast");

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
      { upstreamModel: "fake-openai-model", slug: "rotating" },
      ProviderSchema,
      201,
    );

    assert.equal(withModel.models[0]?.slug, "rotating");

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

  await check("POST /api/providers/:id/credentials/:credentialId/test probes one key", async () => {
    const provider = await postJson(
      providerPaths.list,
      {
        name: "Probing",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "openai-key",
      },
      ProviderSchema,
      201,
    );

    await postJson(
      providerPaths.models(provider.id),
      { upstreamModel: "fake-openai-model", slug: "probing" },
      ProviderSchema,
      201,
    );

    const good = provider.credentials[0];

    if (good === undefined) throw new Error("the Probing provider has no credential");

    const withBad = await postJson(
      providerPaths.credentials(provider.id),
      { label: "expired", apiKey: "wrong-key" },
      ProviderSchema,
      201,
    );

    const bad = withBad.credentials.find((credential) => credential.label === "expired");

    if (bad === undefined) throw new Error("the expired credential is missing");

    const passed = await postJson(
      providerPaths.credentialTest(provider.id, good.id),
      {},
      ProviderCredentialProbeSchema,
      200,
    );

    assert.equal(passed.ok, true);
    assert.equal(passed.error, null);
    assert.ok(passed.latencyMs >= 0);

    const failed = await postJson(
      providerPaths.credentialTest(provider.id, bad.id),
      {},
      ProviderCredentialProbeSchema,
      200,
    );

    assert.equal(failed.ok, false);
    assert.equal(failed.status, 401);
    assert.equal(failed.error, "bad openai key");

    const detail = await getJson(
      providerPaths.detail(provider.id) + "?days=30",
      ProviderDetailSchema,
      200,
    );

    assert.deepEqual(
      detail.provider.credentials.map((credential) => credential.failures),
      [0, 0],
      "the probe flagged a credential for cooldown",
    );

    const cooldowns = await getJson(cooldownPaths.list, CooldownListSchema, 200);

    assert.equal(
      cooldowns.events.some((event) => event.providerName === "Probing"),
      false,
      "the probe wrote a cooldown event",
    );

    assert.equal((await referenceRows("probing")).length, 0, "the probe wrote an analytics row");

    const list = await getJson(providerPaths.list, ProviderListSchema, 200);
    const other = list.providers.find((entry) => entry.id !== provider.id && entry.credentials[0]);

    if (other?.credentials[0] === undefined) throw new Error("no second provider has a credential");

    const foreign = await post(
      providerPaths.credentialTest(provider.id, other.credentials[0].id),
      {},
    );

    const absent = await post(providerPaths.credentialTest(provider.id, "no-such-credential"), {});

    assert.equal(foreign.status, 404);
    assert.equal(absent.status, 404);

    const anonymous = await fetch(
      new URL(providerPaths.credentialTest(provider.id, good.id), origin),
      { method: "POST" },
    );

    assert.equal(anonymous.status, 401);
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

    assert.ok(tag.summary.requests >= 4, `tag filter saw ${tag.summary.requests} requests`);
    assert.deepEqual(tag.models.map((model) => model.model).sort(), ["dead/dead-model", "fast"]);

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
  await check("an address wins over an identical provider ref", async () => {
    const rival = await postJson(
      providerPaths.list,
      {
        name: "Kilo Auto",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "openai-key",
      },
      ProviderSchema,
      201,
    );

    assert.equal(rival.slug, "kilo-auto");

    await postJson(
      providerPaths.models(rival.id),
      { upstreamModel: "free", slug: "kilo-auto-free" },
      ProviderSchema,
      201,
    );

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
      { upstreamModel: "claude-sonnet-4", slug: "kilo-auto/free" },
      ProviderSchema,
      201,
    );

    const model = withModel.models.find((entry) => entry.upstreamModel === "claude-sonnet-4");

    assert.equal(model?.slug, "kilo-auto/free");
    assert.equal(model?.ref, "anthropic/claude-sonnet-4");

    const rivalDetail = await getJson(providerPaths.detail(rival.id), ProviderDetailSchema, 200);

    assert.equal(rivalDetail.provider.models[0]?.shadowed, true);

    const response = await chatRequest("kilo-auto/free", true);

    assert.equal(response.status, 200);

    const stream = await readStream(response);

    assert.equal(stream.text, "Hello from Anthropic");

    const listed = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const models = v.parse(ModelListSchema, await listed.json());

    assert.equal(
      models.data.filter((model) => model.id === "kilo-auto/free").length,
      1,
      "the shadowed provider ref was listed twice",
    );
  });

  await check("reserved refs and slugs are rejected", async () => {
    const reservedAlias = await post(providerPaths.models(openaiProvider.provider?.id ?? ""), {
      upstreamModel: "reserved-model",
      slug: "tags/x",
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
      { upstreamModel: "named-model", slug: "named-fast" },
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
      failover?.models.map((model) => model.slug),
      ["dead/dead-model"],
      `failover order after the model removal: ${failover?.models.map((model) => model.slug).join(", ")}`,
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
      { upstreamModel: "cascade-model", slug: "cascade-alias" },
      ProviderSchema,
      201,
    );

    const model = withModel.models.find((entry) => entry.slug === "cascade-alias");

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

  await check("the longest provider ref and default address are callable", async () => {
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
      { upstreamModel: "m".repeat(200), slug: "long-ref" },
      ProviderSchema,
      201,
    );

    const ref =
      withModel.models.find((model) => model.upstreamModel === "m".repeat(200))?.ref ?? "";

    assert.equal(ref.length, 241);

    const response = await chatRequest(ref, false);

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI");

    const models = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    const list = v.parse(ModelListSchema, await models.json());

    assert.ok(list.data.some((model) => model.id === ref));

    const defaulted = await postJson(
      providerPaths.models(created.id),
      { upstreamModel: "n".repeat(200) },
      ProviderSchema,
      201,
    );

    const address =
      defaulted.models.find((model) => model.upstreamModel === "n".repeat(200))?.slug ?? "";

    assert.equal(address.length, 241);

    const filtered = await getJson(
      `${analyticsPaths.analytics}?days=30&model=${encodeURIComponent(address)}`,
      AnalyticsSchema,
      200,
    );

    assert.equal(filtered.summary.requests, 0);
  });

  await check(
    "POST /v1/messages answers an Anthropic message with a leading system turn",
    async () => {
      const provider = await postJson(
        providerPaths.list,
        {
          name: "Wire OpenAI",
          kind: "openai",
          baseUrl: `${upstreamOrigin}/openai`,
          apiKey: "openai-key",
        },
        ProviderSchema,
        201,
      );

      const withModel = await postJson(
        providerPaths.models(provider.id),
        { upstreamModel: "wire-upstream-model", slug: "wire-openai" },
        ProviderSchema,
        201,
      );

      wireProvider.provider = provider;
      wireProvider.modelId = withModel.models[0]?.id ?? "";

      const response = await postMessages(
        messageRequest("wire-openai", false, [
          { type: "text", text: "be" },
          { type: "text", text: "brief" },
        ]),
        { ...bearer(), [SESSION_ID_HEADER]: "session-messages" },
      );

      assert.equal(response.status, 200);

      const body = v.parse(MessageSchema, await response.json());

      assert.equal(body.model, "wire-openai");
      assert.equal(body.content[0]?.text, "Hello from OpenAI");
      assert.equal(body.stop_reason, "end_turn");
      assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 7 });

      const upstreamBody = upstreamChats.at(-1);

      if (upstreamBody === undefined) throw new Error("the fake OpenAI upstream saw no chat");

      assert.deepEqual(upstreamBody.messages[0], { role: "system", content: "be\nbrief" });

      // The value catalog caches a user's session list for five minutes, so read the row
      // back through the filter instead of the list.
      const tagged = await getJson(
        `${analyticsPaths.analytics}?days=30&sessionId=session-messages`,
        AnalyticsSchema,
        200,
      );

      assert.equal(tagged.summary.requests, 1);

      const providerRef = await postMessages(
        messageRequest("wire-openai/wire-upstream-model", false),
      );

      assert.equal(providerRef.status, 200);
    },
  );

  await check("POST /v1/messages streams the Anthropic event order", async () => {
    const response = await postMessages(messageRequest("claude", true));

    assert.equal(response.status, 200);
    assert.match(contentType(response), /text\/event-stream/);

    const stream = await readMessageStream(response);

    assert.deepEqual(stream.events, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.equal(stream.text, "Hello from Anthropic");
    assert.equal(stream.stopReason, "end_turn");
    assert.equal(stream.inputTokens, 9);
    assert.equal(stream.outputTokens, 5);
  });

  await check("POST /v1/messages falls through a tag to the next model", async () => {
    const dead = await postJson(
      providerPaths.list,
      {
        name: "Dead Wire",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "wrong-key",
      },
      ProviderSchema,
      201,
    );

    const withModel = await postJson(
      providerPaths.models(dead.id),
      { upstreamModel: "dead-wire-model", slug: "dead-wire" },
      ProviderSchema,
      201,
    );

    const deadModel = withModel.models.find((model) => model.slug === "dead-wire");
    const wireModelId = wireProvider.modelId;

    if (deadModel === undefined) throw new Error("the dead wire model is missing");

    if (wireModelId === "") throw new Error("the wire model is missing");

    const created = await postJson(tagPaths.create, { slug: "wire" }, TagListSchema, 201);
    const tag = created.tags.find((entry) => entry.slug === "wire");

    if (tag === undefined) throw new Error("the wire tag is missing");

    await putJson(
      tagPaths.models(tag.id),
      { modelIds: [deadModel.id, wireModelId] },
      TagListSchema,
      200,
    );

    const response = await postMessages(messageRequest("tags/wire", false));

    assert.equal(response.status, 200);

    const body = v.parse(MessageSchema, await response.json());

    assert.equal(body.content[0]?.text, "Hello from OpenAI");

    const rows = await waitForRequests(
      "tags/wire",
      (requests) =>
        requests.some((request) => request.status === "error") &&
        requests.some((request) => request.status === "success"),
      "both Anthropic-wire attempts",
    );

    assert.equal(rows.find((request) => request.status === "error")?.model, "dead-wire");
    assert.equal(rows.find((request) => request.status === "success")?.model, "wire-openai");
  });

  await check("POST /v1/messages carries a tool_use turn and its result", async () => {
    const response = await postMessages({
      model: "wire-openai",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", id: "toolu_1", name: "look", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "looked" }],
        },
      ],
    });

    assert.equal(response.status, 200);
  });

  await check("POST /v1/messages still rejects an image block with 422", async () => {
    const response = await postMessages({
      model: "wire-openai",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", source: {} },
          ],
        },
      ],
    });

    assert.equal(response.status, 422);

    const body = v.parse(MessageErrorSchema, await response.json());

    assert.equal(body.error.type, "invalid_request_error");
    assert.match(body.error.message, /image/);
    assert.match(body.error.message, /messages\.0\.content\.1/);
  });

  await check(
    "POST /v1/messages answers an upstream failure in the Anthropic envelope",
    async () => {
      const response = await postMessages(messageRequest("dead/dead-model", false));

      assert.equal(response.status, 502);

      const body = v.parse(MessageErrorSchema, await response.json());

      assert.equal(body.error.type, "authentication_error");
    },
  );

  await check("POST /v1/messages without a key is an Anthropic 401", async () => {
    const response = await postMessages(messageRequest("wire-openai", false), {});

    assert.equal(response.status, 401);

    const body = v.parse(MessageErrorSchema, await response.json());

    assert.equal(body.error.type, "authentication_error");
  });

  await check("POST /v1/messages/count_tokens estimates from the divisor", async () => {
    const system = "be brief";
    const text = "hello from count";

    const response = await fetch(new URL("/v1/messages/count_tokens", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify({
        model: "wire-openai",
        system,
        messages: [{ role: "user", content: text }],
      }),
    });

    assert.equal(response.status, 200);

    const body = v.parse(TokenCountSchema, await response.json());

    assert.equal(body.input_tokens, Math.ceil((system.length + 1 + text.length) / CHARS_PER_TOKEN));
  });

  await check("PUT a model's compat moves its traffic to the responses wire", async () => {
    const id = openaiProvider.provider?.id ?? "";

    const added = await postJson(
      providerPaths.models(id),
      { upstreamModel: "fake-openai-override", slug: "override-fast" },
      ProviderSchema,
      201,
    );

    overrideModelId = added.models.find((model) => model.slug === "override-fast")?.id ?? "";

    const moved = await putModelEdit(id, overrideModelId, { compat: "responses" });

    const model = moved.models.find((row) => row.id === overrideModelId);

    assert.equal(model?.compat, "responses");
    assert.equal(model?.defaultCompat, "chat");

    const response = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer() },
      body: JSON.stringify({
        model: "override-fast",
        stream: false,
        temperature: 0.1,
        max_tokens: 32,
        stop: ["stop-here"],
        messages: [{ role: "user", content: "hello from the override" }],
      }),
    });

    assert.equal(response.status, 200);

    const body = v.parse(CompletionSchema, await response.json());

    assert.equal(body.choices[0]?.message.content, "Hello from OpenAI Responses");
    assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });

    const cleared = await putModelEdit(id, overrideModelId, { compat: null });

    assert.equal(cleared.models.find((row) => row.id === overrideModelId)?.compat, null);

    const back = await chatRequest("override-fast", false);

    assert.equal(back.status, 200);
    assert.equal(
      v.parse(CompletionSchema, await back.json()).choices[0]?.message.content,
      "Hello from OpenAI",
    );
  });

  await check("a compat the provider kind does not declare is a 422", async () => {
    const id = openaiProvider.provider?.id ?? "";

    const response = await put(
      providerPaths.model(id, overrideModelId),
      modelEdit(await currentModel(id, overrideModelId), { compat: "genai" }),
    );

    assert.equal(response.status, 422);
    assert.equal((await errorBody(response)).code, "validation");
  });

  await check("PUT a model's compat on a missing model is a 404", async () => {
    const id = openaiProvider.provider?.id ?? "";
    const { provider } = await getJson(providerPaths.detail(id), ProviderDetailSchema, 200);
    const addressFree = provider.models.every((row) => row.slug !== "missing-model-address");

    assert.ok(
      addressFree,
      "a model holds missing-model-address, so the address clash answers first",
    );

    const response = await put(
      providerPaths.model(id, "missing-model"),
      modelEdit(await currentModel(id, overrideModelId), {
        slug: "missing-model-address",
        compat: "chat",
      }),
    );

    assert.equal(response.status, 404);
  });

  await check("a stored compat this build does not know answers on the default", async () => {
    const id = openaiProvider.provider?.id ?? "";
    const db = new Database(dbPath);

    try {
      db.query("UPDATE provider_models SET compat = 'rubbish' WHERE id = ?").run(overrideModelId);
    } finally {
      db.close();
    }

    const response = await chatRequest("override-fast", false);

    assert.equal(response.status, 200);
    assert.equal(
      v.parse(CompletionSchema, await response.json()).choices[0]?.message.content,
      "Hello from OpenAI",
    );

    const healed = await putModelEdit(id, overrideModelId, { compat: null });

    assert.equal(healed.models.find((row) => row.id === overrideModelId)?.compat, null);
  });

  await check("a failed responses body is an error, not an empty success", async () => {
    const id = openaiProvider.provider?.id ?? "";

    const added = await postJson(
      providerPaths.models(id),
      { upstreamModel: "fake-openai-broken", slug: "openai-broken" },
      ProviderSchema,
      201,
    );

    const brokenId = added.models.find((model) => model.slug === "openai-broken")?.id ?? "";

    await putModelEdit(id, brokenId, { compat: "responses" });

    const response = await chatRequest("openai-broken", false);

    assert.equal(response.status, 502);

    const error = await openAiError(response);

    assert.equal(error.code, "protocol");
    assert.match(error.message, /the model is broken/);
  });

  await check("a responses stream that fails mid-flight sends an error frame", async () => {
    const id = openaiProvider.provider?.id ?? "";

    const added = await postJson(
      providerPaths.models(id),
      { upstreamModel: "fake-openai-stream-broken", slug: "openai-stream-broken" },
      ProviderSchema,
      201,
    );

    const brokenId = added.models.find((model) => model.slug === "openai-stream-broken")?.id ?? "";

    await putModelEdit(id, brokenId, { compat: "responses" });

    const response = await chatRequest("openai-stream-broken", true);

    assert.equal(response.status, 200);

    const raw = await response.text();

    assert.match(raw, /Half an answer/);
    assert.match(raw, /"code":"protocol"/);
    assert.match(raw, /the stream broke/);
    assert.match(raw, /data: \[DONE\]/);
  });

  await check("GET /api/providers/:id hides another account's provider", async () => {
    const response = await fetch(
      new URL(`${providerPaths.detail("00000000-0000-0000-0000-000000000000")}?days=30`, origin),
      { headers: sessionHeaders() },
    );

    assert.equal(response.status, 404);
  });

  await check("GET /api/backup returns a zip of both databases", async () => {
    const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith("bandar-backup-"));
    const health = await getJson("/api/health", HealthSchema, 200);
    const anonymous = await fetch(new URL(apiPaths.backup, origin));

    assert.equal(anonymous.status, 401);

    const response = await fetch(new URL(apiPaths.backup, origin), { headers: sessionHeaders() });

    if (response.status !== 200) {
      const body = await response.text();

      // The cause lands on the server stderr; give the reader a moment to collect it.
      await Bun.sleep(250);

      throw new Error(
        `the route answered ${String(response.status)}: ${body}\n` +
          `server stderr: ${first.errors().slice(-1500)}`,
      );
    }

    assert.match(contentType(response), /^application\/zip/);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="bandar-backup-[0-9.]+-[0-9]{8}T[0-9]{6}Z[.]zip"$/u,
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    const archive = join(workDir, "backup.zip");

    writeFileSync(archive, bytes);

    const members = unzip(bytes);

    assert.deepEqual(
      members.map((member) => member.name),
      ["bandar.db", "bandar.duckdb", "manifest.json"],
    );

    const manifest = v.parse(
      BackupManifestSchema,
      JSON.parse(new TextDecoder().decode(unzipMember(members, "manifest.json"))),
    );

    assert.equal(manifest.sqliteTag, health.migration);
    assert.equal(manifest.duckdbTag, health.duckMigration);

    for (const recorded of manifest.members) {
      const data = unzipMember(members, recorded.name);

      assert.equal(data.byteLength, recorded.size);
      assert.equal(createHash("sha256").update(data).digest("hex"), recorded.sha256);
    }

    assert.equal(
      new TextDecoder().decode(unzipMember(members, "bandar.db").subarray(0, 15)),
      "SQLite format 3",
    );

    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) => name.startsWith("bandar-backup-")),
      leftovers,
      "a temporary copy outlived the response",
    );

    if (Bun.which("unzip") !== null) {
      const checked = Bun.spawnSync(["unzip", "-t", archive], { stdout: "pipe", stderr: "pipe" });

      assert.equal(checked.exitCode, 0, checked.stderr.toString());
    }
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

    assert.deepEqual(
      list.providers
        .filter((provider) => provider.origin === "builtin")
        .map((provider) => provider.kind)
        .sort(),
      ["hyper", "kilocode", "nous", "opencode", "river", "tokenharbor", "yeta", "zro"],
      "a built-in provider was seeded twice",
    );
  });
} finally {
  await second.stop();
  await upstream.stop(true);
  await kilocode.stop(true);
  await builtIns.stop(true);
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

async function boot(port = 0, timeoutMs = BOOT_TIMEOUT_MS): Promise<Booted> {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing; run \`bun run build\` first`);

  mkdirSync(homeDir, { recursive: true });

  writeFileSync(
    join(homeDir, "config.json"),
    JSON.stringify({
      server: { port },
      providers: {
        kilocode: {
          baseUrl: `${kilocodeOrigin}/api/openrouter`,
          catalogUrl: `${kilocodeOrigin}/api/gateway/models`,
        },
        tokenharbor: { baseUrl: `${builtInsOrigin}/tokenharbor/v1` },
        yeta: { baseUrl: `${builtInsOrigin}/yeta/v1` },
        river: {
          baseUrl: `${builtInsOrigin}/river/v1`,
          catalogUrl: `${builtInsOrigin}/river/pricing`,
        },
        nous: {
          baseUrl: `${builtInsOrigin}/nous/v1`,
          authUrl: `${builtInsOrigin}/portal`,
        },
        hyper: { baseUrl: `${builtInsOrigin}/hyper/v1` },
        opencode: { baseUrl: `${builtInsOrigin}/opencode/inference` },
        zro: { baseUrl: `${builtInsOrigin}/zro/v1` },
      },
    }),
  );

  const started = Date.now();

  const proc = Bun.spawn([BINARY], {
    env: {
      ...Bun.env,
      BANDAR_HOME: homeDir,
      BANDAR_AUTH_SECRET: AUTH_SECRET,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const log = collect(proc.stdout);
  const errors = collect(proc.stderr);

  const deadline = started + timeoutMs;

  while (Date.now() < deadline) {
    const found = log.text().match(/listening on (http:\/\/\S+)/)?.[1];

    if (found) return { origin: found, log: log.text, errors: errors.text, stop: () => stop(proc) };

    if (proc.exitCode !== null) {
      await Promise.race([errors.done, Bun.sleep(1_000)]);

      throw new Error(`the binary exited with ${proc.exitCode}\n${errors.text()}`);
    }

    await Bun.sleep(25);
  }

  const waited = Date.now() - started;

  proc.kill();
  // Reading the pipes only after the exit keeps whatever a killed child wrote last: a read that
  // races the kill reports an empty stderr for a child that did print. A descendant that inherited
  // the pipes can hold them open, so each read is bounded and the message reports what arrived.
  await proc.exited;
  await Promise.race([log.done, Bun.sleep(1_000)]);
  await Promise.race([errors.done, Bun.sleep(1_000)]);

  throw new Error(
    `the binary never reported a port on ${String(port)} after ${String(waited)}ms ` +
      `(exit ${String(proc.exitCode)})\nstdout:\n${log.text()}\nstderr:\n${errors.text()}`,
  );
}

type Collected = { readonly text: () => string; readonly done: Promise<string> };

function collect(stream: ReadableStream<Uint8Array>): Collected {
  let text = "";
  const decoder = new TextDecoder();

  const done = (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });

    return text;
  })();

  return { text: () => text, done };
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

async function currentModel(providerId: string, modelId: string): Promise<ProviderModel> {
  const { provider } = await getJson(providerPaths.detail(providerId), ProviderDetailSchema, 200);
  const model = provider.models.find((row) => row.id === modelId);

  if (model === undefined) throw new Error(`model ${modelId} is on no provider`);

  return model;
}

function modelEdit(
  model: ProviderModel,
  change: Partial<ProviderModelEditInput>,
): ProviderModelEditInput {
  return {
    slug: model.slug,
    alias: model.alias,
    compat: model.compat,
    inputPricePerMtok: model.inputPricePerMtok,
    cacheInputPricePerMtok: model.cacheInputPricePerMtok,
    outputPricePerMtok: model.outputPricePerMtok,
    ...change,
  };
}

async function putModelEdit(
  providerId: string,
  modelId: string,
  change: Partial<ProviderModelEditInput>,
): Promise<Provider> {
  return putJson(
    providerPaths.model(providerId, modelId),
    modelEdit(await currentModel(providerId, modelId), change),
    ProviderSchema,
    200,
  );
}

function messageRequest(model: string, stream: boolean, system?: Json): Json {
  const body = {
    model,
    stream,
    max_tokens: 64,
    thinking: { type: "enabled", budget_tokens: 1024 },
    metadata: { user_id: "smoke" },
    top_k: 5,
    messages: [{ role: "user", content: `hello from ${model}` }],
  };

  return system === undefined ? body : { ...body, system };
}

function postMessages(
  body: Json,
  headers: Readonly<Record<string, string>> = bearer(),
): Promise<Response> {
  return fetch(new URL("/v1/messages", origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readMessageStream(response: Response): Promise<{
  events: readonly string[];
  text: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}> {
  const raw = await response.text();
  const events: string[] = [];
  let text = "";
  let stopReason: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const frame of raw.split("\n\n")) {
    if (frame.trim() === "") continue;

    const lines = frame.split("\n");
    const name = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
    const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);

    assert.ok(
      name !== undefined && data !== undefined,
      `frame without an event line and a data line: ${frame}`,
    );

    const event = v.parse(MessageEventSchema, JSON.parse(data));

    assert.equal(event.type, name, "the event line disagrees with the data type");
    events.push(name);

    if (event.type === "content_block_delta") text += event.delta?.text ?? "";

    if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? null;
      inputTokens = event.usage?.input_tokens ?? null;
      outputTokens = event.usage?.output_tokens ?? null;
    }
  }

  return { events, text, stopReason, inputTokens, outputTokens };
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

type ZipMember = { readonly name: string; readonly data: Uint8Array };

/** Walk the central directory, the record an extractor starts from. */
function unzip(bytes: Uint8Array): readonly ZipMember[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  const count = view.getUint16(end + 10, true);
  const members: ZipMember[] = [];
  let directory = view.getUint32(end + 16, true);

  for (let index = 0; index < count; index += 1) {
    const method = view.getUint16(directory + 10, true);
    const compressed = view.getUint32(directory + 20, true);
    const nameLength = view.getUint16(directory + 28, true);
    const extraLength = view.getUint16(directory + 30, true);
    const commentLength = view.getUint16(directory + 32, true);
    const local = view.getUint32(directory + 42, true);

    const name = new TextDecoder().decode(
      bytes.subarray(directory + 46, directory + 46 + nameLength),
    );

    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const payload = bytes.subarray(start, start + compressed);

    members.push({ name, data: method === 8 ? new Uint8Array(inflateRawSync(payload)) : payload });
    directory += 46 + nameLength + extraLength + commentLength;
  }

  return members;
}

function unzipMember(members: readonly ZipMember[], name: string): Uint8Array {
  const found = members.find((member) => member.name === name);

  if (found === undefined) throw new Error(`${name} is not in the archive`);

  return found.data;
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
      const raw: unknown = await request.clone().json();
      const body = v.safeParse(v.object({ stream: v.optional(v.boolean()) }), raw);
      const stream = body.success ? (body.output.stream ?? false) : false;

      if (url.pathname === "/openai/chat/completions") {
        if (request.headers.get("authorization") !== "Bearer openai-key") {
          return jsonError(401, "bad openai key");
        }

        if (!stream) {
          const probe = v.safeParse(UpstreamChatSchema, raw);

          if (probe.success) upstreamChats.push(probe.output);

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

      if (url.pathname === "/openai/responses") {
        if (request.headers.get("authorization") !== "Bearer openai-key") {
          return jsonError(401, "bad openai key");
        }

        const parsed = v.safeParse(ResponsesBodySchema, await request.json());

        if (!parsed.success) return jsonError(400, "the openai responses body is off");

        if (parsed.output.model === "fake-openai-stream-broken") {
          return sse([
            { type: "response.output_text.delta", delta: "Half an answer" },
            {
              type: "response.failed",
              response: { status: "failed", output: [], error: { message: "the stream broke" } },
            },
          ]);
        }

        if (parsed.output.model === "fake-openai-broken") {
          return Response.json({
            status: "failed",
            output: [],
            error: { message: "the model is broken" },
          });
        }

        if (
          parsed.output.model === "fake-openai-override" &&
          parsed.output.max_output_tokens !== 32
        ) {
          return jsonError(400, "the responses wire did not carry max_output_tokens");
        }

        if (parsed.output.stream === true) {
          return sse([
            { type: "response.created", response: { status: "in_progress", output: [] } },
            { type: "response.output_text.delta", delta: "Hello from OpenAI " },
            { type: "response.output_text.delta", delta: "Responses" },
            {
              type: "response.completed",
              response: {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "Hello from OpenAI Responses" }],
                  },
                ],
                usage: { input_tokens: 12, output_tokens: 4 },
              },
            },
            "[DONE]",
          ]);
        }

        return Response.json({
          status: "completed",
          output: [
            { type: "reasoning", summary: [] },
            {
              type: "message",
              content: [{ type: "output_text", text: "Hello from OpenAI Responses" }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 4 },
        });
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
            { id: "fast", pricing: { prompt: "0.000001", completion: "0.000002" } },
          ],
        });
      }

      return jsonError(404, `no fake kilo route for ${url.pathname}`);
    },
  });
}

function startBuiltIns() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";

      if (url.pathname.startsWith("/opencode/")) opencodeState.requests += 1;

      if (url.pathname === "/tokenharbor/v1/models") {
        if (authorization !== "Bearer thk_test") return jsonError(401, "bad token harbor key");

        return Response.json({
          object: "list",
          data: [
            { id: "thk-pro", object: "model" },
            { id: "thk-mini", object: "model" },
          ],
        });
      }

      if (url.pathname === "/tokenharbor/v1/chat/completions") {
        if (authorization !== "Bearer thk_test") return jsonError(401, "bad token harbor key");

        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Hello from Token Harbor" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        });
      }

      if (url.pathname === "/yeta/v1/models") {
        if (authorization !== "Bearer yeta_test") return jsonError(401, "bad yeta key");

        return Response.json({
          object: "list",
          data: [
            { id: "yeta-large", object: "model" },
            { id: "yeta-image", object: "model" },
          ],
        });
      }

      if (url.pathname === "/api/pricing") {
        return Response.json({
          success: true,
          data: [
            { model_name: "yeta-large", model_ratio: 1.5, completion_ratio: 4, quota_type: 0 },
            { model_name: "yeta-image", model_ratio: 1, completion_ratio: 1, quota_type: 1 },
            { model_name: "yeta-retired", model_ratio: 9, completion_ratio: 9, quota_type: 0 },
          ],
        });
      }

      if (url.pathname === "/yeta/v1/chat/completions") {
        if (authorization !== "Bearer yeta_test") return jsonError(401, "bad yeta key");

        const body = v.safeParse(
          v.object({ stream: v.optional(v.boolean()) }),
          await request.json(),
        );

        const stream = body.success ? (body.output.stream ?? false) : false;

        if (!stream) {
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: "Hello from Yeta" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          });
        }

        return sse([
          { choices: [{ delta: { role: "assistant", content: "Hello" } }] },
          {
            choices: [{ delta: { content: " from Yeta" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          },
          "[DONE]",
        ]);
      }

      if (url.pathname === "/river/pricing") {
        return Response.json({
          inference: [
            { model: "river-flow", input: 0.4, cached_input: 0.1, output: 1.6 },
            { model: "river-deep", input: 2, cached_input: 0.5, output: 8 },
            { model: "river-flow", input: 0.4, cached_input: 0.1, output: 1.6 },
          ],
        });
      }

      if (url.pathname === "/river/v1/models") {
        if (authorization !== "Bearer rv_test") return jsonError(401, "bad river key");

        return Response.json({ object: "list", data: [{ id: "river-flow", object: "model" }] });
      }

      if (url.pathname === "/river/v1/chat/completions") {
        if (authorization !== "Bearer rv_test") return jsonError(401, "bad river key");

        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Hello from River" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        });
      }

      if (url.pathname === "/hyper/v1/models") {
        if (authorization !== "") return jsonError(401, "the hyper catalog is public");

        return Response.json({
          object: "list",
          data: [
            {
              id: "hyper-prism",
              display_name: "Prism",
              pricing: { input: 2.5, output: 6, cache_create: 3, cache_hit: 0.5 },
            },
            { id: "hyper-noted", pricing: { input: "0.834", output: "2.501" } },
            { id: "hyper-unpriced" },
          ],
        });
      }

      if (url.pathname === "/hyper/v1/chat/completions") {
        if (authorization !== "Bearer hyper_test") return jsonError(401, "bad hyper key");

        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Hello from Hyper" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        });
      }

      if (url.pathname === "/opencode/inference/go/v1/models") {
        if (authorization !== "") return jsonError(401, "the opencode go catalog is public");

        return Response.json({
          object: "list",
          data: [
            { id: "glm-5.3" },
            { id: "claude-haiku-5-5" },
            { id: "gemini-4-argon" },
            { id: "gpt-6-luna" },
            { id: "omen-alpha" },
            { id: "not-a-go-model" },
          ],
        });
      }

      if (url.pathname === "/opencode/inference/go/openai/v1/chat/completions") {
        if (authorization !== "Bearer opencode_test") return jsonError(401, "bad opencode key");

        if (request.headers.has("x-api-key") || request.headers.has("x-goog-api-key")) {
          return jsonError(401, "opencode go takes one bearer");
        }

        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Hello from OpenCode OpenAI" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        });
      }

      if (url.pathname === "/opencode/inference/go/openai/v1/responses") {
        if (authorization !== "Bearer opencode_test") return jsonError(401, "bad opencode key");

        if (request.headers.has("x-api-key") || request.headers.has("x-goog-api-key")) {
          return jsonError(401, "opencode go takes one bearer");
        }

        const parsed = v.safeParse(ResponsesBodySchema, await request.json());

        if (!parsed.success) {
          return jsonError(400, "opencode go responses wants the responses body");
        }

        if (parsed.output.stream === true) {
          return sse([
            { type: "response.created", response: { status: "in_progress", output: [] } },
            { type: "response.output_text.delta", delta: "Hello from OpenCode " },
            { type: "response.output_text.delta", delta: "Responses" },
            {
              type: "response.completed",
              response: {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "Hello from OpenCode Responses" }],
                  },
                ],
                usage: { input_tokens: 7, output_tokens: 3 },
              },
            },
            "[DONE]",
          ]);
        }

        return Response.json({
          status: "completed",
          output: [
            { type: "reasoning", summary: [] },
            {
              type: "message",
              content: [{ type: "output_text", text: "Hello from OpenCode Responses" }],
            },
          ],
          usage: { input_tokens: 7, output_tokens: 3 },
        });
      }

      if (url.pathname === "/opencode/inference/go/anthropic/v1/messages") {
        if (authorization !== "Bearer opencode_test") return jsonError(401, "bad opencode key");

        if (request.headers.get("anthropic-version") !== "2023-06-01") {
          return jsonError(400, "opencode go messages needs the version header");
        }

        if (request.headers.has("x-api-key")) return jsonError(401, "opencode go takes one bearer");

        const body = v.safeParse(
          v.object({ stream: v.optional(v.boolean()) }),
          await request.json(),
        );

        if (body.success && body.output.stream === true) {
          return sse([
            {
              type: "message_start",
              message: { usage: { input_tokens: 5, output_tokens: 0 } },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Hello from OpenCode Anthropic" },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ]);
        }

        return Response.json({
          content: [{ type: "text", text: "Hello from OpenCode Anthropic" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        });
      }

      if (url.pathname.includes("/opencode/inference/go/google/v1beta/models/")) {
        if (authorization !== "Bearer opencode_test") return jsonError(401, "bad opencode key");

        if (request.headers.has("x-goog-api-key")) {
          return jsonError(401, "opencode go takes one bearer");
        }

        const stream = url.pathname.endsWith(":streamGenerateContent");

        if (!stream && !url.pathname.endsWith(":generateContent")) {
          return jsonError(404, `no fake opencode google route for ${url.pathname}`);
        }

        if (stream) {
          return sse([
            {
              candidates: [{ content: { parts: [{ text: "Hello from OpenCode Google" }] } }],
            },
            {
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
            },
          ]);
        }

        return Response.json({
          candidates: [
            {
              content: { parts: [{ text: "Hello from OpenCode Google" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
        });
      }

      if (url.pathname === "/nous/v1/models") {
        return Response.json({
          data: [
            {
              id: "nous-text-large",
              architecture: { output_modalities: ["text"] },
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            {
              id: "nous-omni",
              architecture: { output_modalities: ["text", "image"] },
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
            {
              id: "nous-image",
              architecture: { output_modalities: ["image"] },
              pricing: { prompt: "0.00001", completion: "0.00002" },
            },
            { id: "nous-unpriced" },
          ],
        });
      }

      if (url.pathname === "/nous/v1/chat/completions") {
        if (!authorization.startsWith("Bearer nous-access-")) {
          return jsonError(401, "bad nous access token");
        }

        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Hello from Nous Portal" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 5 },
        });
      }

      if (url.pathname === "/zro/v1/models") {
        if (authorization !== "Bearer zro_test") return jsonError(401, "bad zro key");

        return Response.json({
          object: "list",
          data: [
            { id: "zro/glm-5.3-flash", object: "model" },
            { id: "glm-5.3-flash", object: "model" },
            { id: "deepseek-v4.1-flash", object: "model" },
            { id: "minimax-m3.1-flash", object: "model" },
            { id: "dolly1-security", object: "model" },
            { id: "zro-newcomer", object: "model" },
            { id: "zro/glm-5.3", object: "model" },
            { id: "zro/only-prefixed", object: "model" },
          ],
        });
      }

      if (url.pathname === "/zro/v1/chat/completions") {
        if (authorization !== "Bearer zro_test") return jsonError(401, "bad zro key");

        if (request.headers.has("x-api-key")) return jsonError(401, "zro takes one bearer");

        const body = v.safeParse(
          v.object({ stream: v.optional(v.boolean()) }),
          await request.json(),
        );

        const stream = body.success ? (body.output.stream ?? false) : false;

        if (!stream) {
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: "Hello from Zro" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 6, completion_tokens: 2 },
          });
        }

        return sse([
          { choices: [{ delta: { role: "assistant", content: "Hello" } }] },
          {
            choices: [{ delta: { content: " from Zro" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 6, completion_tokens: 2 },
          },
          "[DONE]",
        ]);
      }

      if (url.pathname === "/zro/v1/messages") {
        if (authorization !== "Bearer zro_test") return jsonError(401, "bad zro key");

        if (request.headers.get("anthropic-version") !== "2023-06-01") {
          return jsonError(400, "zro messages needs the version header");
        }

        if (request.headers.has("x-api-key")) return jsonError(401, "zro takes one bearer");

        return Response.json({
          content: [{ type: "text", text: "Hello from Zro Messages" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 4 },
        });
      }

      if (url.pathname === "/portal/api/oauth/device/code" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());

        if (form.get("client_id") !== "hermes-cli" || form.get("scope") !== "inference:invoke") {
          return jsonError(400, "bad nous device code request");
        }

        nousState.deviceStarts += 1;

        return Response.json({
          device_code: `nous-device-${String(nousState.deviceStarts)}`,
          user_code: "NOUS-CODE",
          verification_uri: "https://portal.nousresearch.com/manage-subscription",
          verification_uri_complete:
            "https://portal.nousresearch.com/manage-subscription?code=NOUS-CODE",
          expires_in: 600,
          interval: 5,
        });
      }

      if (url.pathname === "/portal/api/oauth/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());

        if (form.get("client_id") !== "hermes-cli") return jsonError(400, "bad nous client");

        if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
          if (form.get("device_code") === "nous-device-2") {
            return Response.json({
              access_token: "nous-access-1",
              token_type: "Bearer",
              expires_in: 0,
            });
          }

          nousState.polls += 1;

          if (nousState.polls === 1) {
            return Response.json({ error: "authorization_pending" }, { status: 400 });
          }

          return Response.json({
            access_token: "nous-access-1",
            refresh_token: "rt-1",
            token_type: "Bearer",
            expires_in: 0,
          });
        }

        if (form.get("grant_type") === "refresh_token") {
          const presented = request.headers.get("x-nous-refresh-token") ?? "";

          nousState.presented.push(presented);

          if (presented !== nousState.refreshToken) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }

          // A slow rotation keeps a concurrent burst inside one renewal slot.
          await Bun.sleep(400);

          nousState.refreshToken = `rt-${String(nousState.presented.length + 1)}`;

          return Response.json({
            access_token: `nous-access-${String(nousState.presented.length + 1)}`,
            refresh_token: nousState.refreshToken,
            token_type: "Bearer",
            expires_in: 0,
          });
        }

        return jsonError(400, "unsupported nous grant");
      }

      return jsonError(404, `no fake built-in route for ${url.pathname}`);
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
