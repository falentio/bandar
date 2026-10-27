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
} from "../src/shared/analytics";
import { ApiErrorBodySchema, HealthSchema } from "../src/shared/api";
import { API_KEY_HEADER, CreatedApiKeySchema } from "../src/shared/api-keys";
import { AuthResultSchema } from "../src/shared/auth";
import { ProviderListSchema, ProviderSchema, providerPaths } from "../src/shared/providers";

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

let failures = 0;
let cookie = "";
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

  await check("POST /api/providers creates an OpenAI provider and hides its key", async () => {
    const provider = await postJson(
      providerPaths.list,
      {
        name: "Fake OpenAI",
        kind: "openai",
        baseUrl: `${upstreamOrigin}/openai`,
        apiKey: "openai-key",
        models: [{ upstreamModel: "fake-openai-model", alias: "fast" }],
      },
      ProviderSchema,
      201,
    );

    assert.equal(provider.hasKey, true);
    assert.equal(provider.models[0]?.alias, "fast");
    assert.equal(Object.hasOwn(provider, "apiKey"), false);
  });

  await check("POST /api/providers creates Anthropic and Google providers", async () => {
    await postJson(
      providerPaths.list,
      {
        name: "Fake Anthropic",
        kind: "anthropic",
        baseUrl: `${upstreamOrigin}/anthropic`,
        apiKey: "anthropic-key",
        models: [{ upstreamModel: "fake-claude", alias: "claude" }],
      },
      ProviderSchema,
      201,
    );

    await postJson(
      providerPaths.list,
      {
        name: "Fake Google",
        kind: "google",
        baseUrl: `${upstreamOrigin}/google`,
        apiKey: "google-key",
        models: [{ upstreamModel: "fake-gemini", alias: "gemini" }],
      },
      ProviderSchema,
      201,
    );
  });

  await check("GET /api/providers lists three providers without secrets", async () => {
    const list = await getJson(providerPaths.list, ProviderListSchema, 200);

    assert.equal(list.providers.length, 3);
    assert.ok(list.providers.every((provider) => provider.hasKey));
    assert.ok(list.providers.every((provider) => !Object.hasOwn(provider, "apiKey")));
  });

  await check("POST /api/providers rejects a duplicate alias with 409", async () => {
    const response = await post(providerPaths.list, {
      name: "Duplicate",
      kind: "openai",
      baseUrl: `${upstreamOrigin}/openai`,
      apiKey: "",
      models: [{ upstreamModel: "other-model", alias: "fast" }],
    });

    assert.equal(response.status, 409);
    assert.equal((await errorBody(response)).code, "conflict");
  });

  await check("POST /api/auth/api-key/create mints a gateway key", async () => {
    const response = await post(
      "/api/auth/api-key/create",
      { name: "smoke key" },
      { origin: requestOrigin },
    );

    assert.equal(response.status, 200);

    const minted = v.parse(CreatedApiKeySchema, await response.json());
    assert.ok(minted.key.startsWith("bandar_"), `key ${minted.key} lacks the bandar_ prefix`);

    apiKey = minted.key;
    keyId = minted.id;
  });

  await check("GET /v1/models lists the caller's aliases", async () => {
    const response = await fetch(new URL("/v1/models", origin), { headers: bearer() });
    assert.equal(response.status, 200);

    const body = v.parse(
      v.object({
        object: v.literal("list"),
        data: v.array(v.object({ id: v.string(), object: v.literal("model") })),
      }),
      await response.json(),
    );

    assert.deepEqual(body.data.map((model) => model.id).sort(), ["claude", "fast", "gemini"]);
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
  });
} finally {
  await second.stop();
  await upstream.stop(true);
  rmSync(workDir, { recursive: true, force: true });
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let log = "";
  const stderr = new Response(proc.stderr).text().catch(() => "");

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
  assert.equal(response.status, status);

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
