import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { addProviderCredential } from "../credentials";
import { user } from "../db/auth-schema";
import { openDatabase, type DatabaseHandle } from "../db/client";
import { applyMigrations, type Migration } from "../db/migrate";
import { cooldownEvents, providerCredentials, providerModels, providers } from "../db/schema";
import { DuckDb, type QueryRow } from "../duck/client";
import { applyDuckMigrations } from "../duck/migrate";
import {
  addProviderModel,
  createProvider,
  updateProviderModel,
  type ProviderDeps,
} from "../providers";
import { DEFAULT_PROVIDER_ENDPOINTS } from "../providers/endpoints";
import { ensureBuiltInProviders } from "../providers/seeding";
import { createSealer } from "../seal";
import { createTag, setTagModels } from "../tags";
import { runChat, type ChatDeps, type ChatInput } from "./chat";
import type { Auth } from "../auth";
import { createGateway } from "../gateway";
import { ChatCompletionRequestSchema } from "../../shared/chat";
import { toolById, toolStatus } from "../../shared/cli-tools";
import type { JsonValue } from "../../shared/json";
import type { GenericProviderKind } from "../../shared/providers";
import { anthropicWire } from "./anthropic-wire";

const SQLITE_DIR = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const DUCK_DIR = fileURLToPath(new URL("../../../duckdb", import.meta.url));
const DUCK_LIB = fileURLToPath(new URL("../../../vendor/duckdb/libduckdb.so", import.meta.url));

const CompletionSchema = v.object({
  choices: v.array(
    v.object({
      message: v.object({ role: v.string(), content: v.string() }),
      finish_reason: v.string(),
    }),
  ),
});

const ErrorSchema = v.object({ error: v.object({ message: v.string(), code: v.string() }) });

const CompletionUsageSchema = v.object({
  usage: v.object({
    prompt_tokens: v.number(),
    completion_tokens: v.number(),
    total_tokens: v.number(),
  }),
});

const MessageUsageSchema = v.object({
  usage: v.object({
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_input_tokens: v.optional(v.number()),
  }),
});

const ResponseBodySchema = v.object({
  id: v.string(),
  object: v.literal("response"),
  status: v.string(),
  output: v.array(
    v.object({
      id: v.string(),
      type: v.string(),
      status: v.optional(v.string()),
      role: v.optional(v.string()),
      content: v.optional(
        v.array(
          v.object({
            type: v.string(),
            text: v.string(),
            annotations: v.optional(v.array(v.unknown())),
          }),
        ),
      ),
    }),
  ),
  usage: v.object({ input_tokens: v.number(), output_tokens: v.number() }),
  error: v.nullable(v.object({ message: v.string() })),
  incomplete_details: v.nullable(v.object({ reason: v.string() })),
});

type ChatCompletionBody = v.InferInput<typeof ChatCompletionRequestSchema>;

type Call = {
  readonly path: string;
  readonly key: string | null;
  readonly body: unknown;
};

type Upstream = {
  readonly origin: string;
  readonly calls: Call[];
  readonly stop: () => void;
};

type Harness = {
  readonly deps: ChatDeps;
  readonly providers: ProviderDeps;
  readonly db: DatabaseHandle["db"];
  readonly upstream: Upstream;
};

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const stop of cleanup) stop();
  cleanup = [];
});

describe("runChat cooldowns", () => {
  test("tries the next credential after an auth failure and flags the first", async () => {
    const harness = await freshHarness(openAiUpstream("good-key"));

    const provider = await createProvider(harness.providers, "user-1", {
      name: "Primary",
      kind: "openai",
      baseUrl: harness.upstream.origin,
      apiKey: "",
    });

    await addProviderModel(harness.providers, "user-1", provider.id, {
      upstreamModel: "m",
      slug: "fast",
    });
    await addCredential(harness.providers, provider.id, "bad", "bad-key");
    await addCredential(harness.providers, provider.id, "good", "good-key");

    const response = await runChat(harness.deps, chatInput("fast"));

    expect(response.status).toBe(200);
    expect(v.parse(CompletionSchema, await response.json()).choices[0]?.message.content).toBe(
      "hello",
    );
    expect(harness.upstream.calls.map((call) => call.key)).toEqual([
      "Bearer bad-key",
      "Bearer good-key",
    ]);

    const bad = credentialNamed(harness.db, "bad");
    const good = credentialNamed(harness.db, "good");

    expect(bad?.failures).toBe(1);
    expect(bad?.flaggedUntil).not.toBeNull();

    const cooldown = (bad?.flaggedUntil?.getTime() ?? 0) - Date.now();

    expect(cooldown).toBeGreaterThan(25_000);
    expect(cooldown).toBeLessThan(35_000);
    expect(good?.failures).toBe(0);
    expect(good?.flaggedUntil).toBeNull();

    const providerRow = providerRowOf(harness.db, provider.id);

    expect(providerRow?.failures).toBe(0);
    expect(providerRow?.flaggedUntil).toBeNull();

    const history = harness.db.select().from(cooldownEvents).all();

    expect(history).toHaveLength(1);
    expect(history[0]?.subject).toBe("credential");
    expect(history[0]?.errorKind).toBe("auth");
    expect(history[0]?.reference).toBe("fast");
    expect(history[0]?.modelSlug).toBe("fast");
  });

  test("tries the next credential after a rate limit and flags the first", async () => {
    const harness = await freshHarness((call) =>
      call.key === "Bearer good-key"
        ? openAiSuccess()
        : Response.json({ error: { message: "slow down" } }, { status: 429 }),
    );

    const provider = await createProvider(harness.providers, "user-1", {
      name: "Primary",
      kind: "openai",
      baseUrl: harness.upstream.origin,
      apiKey: "",
    });

    await addProviderModel(harness.providers, "user-1", provider.id, {
      upstreamModel: "m",
      slug: "fast",
    });
    await addCredential(harness.providers, provider.id, "limited", "limited-key");
    await addCredential(harness.providers, provider.id, "good", "good-key");

    const response = await runChat(harness.deps, chatInput("fast"));

    expect(response.status).toBe(200);
    expect(harness.upstream.calls.map((call) => call.key)).toEqual([
      "Bearer limited-key",
      "Bearer good-key",
    ]);

    const limited = credentialNamed(harness.db, "limited");

    expect(limited?.failures).toBe(1);
    expect(limited?.flaggedUntil).not.toBeNull();
    expect(providerRowOf(harness.db, provider.id)?.failures).toBe(0);
    expect(
      harness.db.select().from(providerModels).where(eq(providerModels.slug, "fast")).get()
        ?.failures,
    ).toBe(0);

    const history = harness.db.select().from(cooldownEvents).all();

    expect(history).toHaveLength(1);
    expect(history[0]?.subject).toBe("credential");
    expect(history[0]?.errorKind).toBe("rate_limit");
  });

  test("skips a cooling credential on the next request", async () => {
    const harness = await freshHarness(openAiUpstream("good-key"));

    const provider = await createProvider(harness.providers, "user-1", {
      name: "Primary",
      kind: "openai",
      baseUrl: harness.upstream.origin,
      apiKey: "",
    });

    await addProviderModel(harness.providers, "user-1", provider.id, {
      upstreamModel: "m",
      slug: "fast",
    });
    await addCredential(harness.providers, provider.id, "bad", "bad-key");
    await addCredential(harness.providers, provider.id, "good", "good-key");

    expect((await runChat(harness.deps, chatInput("fast"))).status).toBe(200);

    const before = harness.upstream.calls.length;
    const eventsBefore = requestEvents(harness.deps.duck).length;
    const second = await runChat(harness.deps, chatInput("fast"));

    expect(second.status).toBe(200);
    expect(requestEvents(harness.deps.duck).length - eventsBefore).toBe(1);

    const fresh = harness.upstream.calls.slice(before);

    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.key).toBe("Bearer good-key");
  });

  test("falls through a failing provider to the next model in a tag", async () => {
    const harness = await freshHarness((call) =>
      call.path === "/dead/chat/completions"
        ? Response.json({ error: { message: "upstream is down" } }, { status: 500 })
        : openAiSuccess(),
    );

    const dead = await providerWithModel(harness, {
      name: "Dead",
      path: "/dead",
      slug: "dead",
      upstreamModel: "dead-model",
    });

    const alive = await providerWithModel(harness, {
      name: "Alive",
      path: "/alive",
      slug: "alive",
      upstreamModel: "alive-model",
    });

    await tagWith(harness, "failover", [dead.modelId, alive.modelId]);

    const response = await runChat(harness.deps, chatInput("tags/failover"));

    expect(response.status).toBe(200);
    expect(harness.upstream.calls.map((call) => call.path)).toEqual([
      "/dead/chat/completions",
      "/alive/chat/completions",
    ]);

    const deadRow = providerRowOf(harness.db, dead.providerId);

    expect(deadRow?.failures).toBe(1);
    expect(deadRow?.flaggedUntil).not.toBeNull();

    const before = harness.upstream.calls.length;
    const second = await runChat(harness.deps, chatInput("tags/failover"));

    expect(second.status).toBe(200);
    expect(harness.upstream.calls.slice(before).map((call) => call.path)).toEqual([
      "/alive/chat/completions",
    ]);
  });

  test("convicts the provider on a socket-level failure and falls through it", async () => {
    const harness = await freshHarness(() => openAiSuccess());

    const dead = await providerWithModel(harness, {
      name: "Dead",
      path: "",
      slug: "dead",
      upstreamModel: "dead-model",
      origin: deadOrigin(),
    });

    const alive = await providerWithModel(harness, {
      name: "Alive",
      path: "/alive",
      slug: "alive",
      upstreamModel: "alive-model",
    });

    await tagWith(harness, "socket-failover", [dead.modelId, alive.modelId]);

    const response = await runChat(harness.deps, chatInput("tags/socket-failover"));

    expect(response.status).toBe(200);
    expect(harness.upstream.calls.map((call) => call.path)).toEqual(["/alive/chat/completions"]);
    expect(providerRowOf(harness.db, dead.providerId)?.failures).toBe(1);
    expect(providerRowOf(harness.db, dead.providerId)?.flaggedUntil).not.toBeNull();
    expect(providerRowOf(harness.db, alive.providerId)?.failures).toBe(0);
  });

  test("answers 502 and convicts nobody for an unclassified status", async () => {
    const harness = await freshHarness(() =>
      Response.json({ error: { message: "payment required" } }, { status: 402 }),
    );

    const seeded = await providerWithModel(harness, {
      name: "Unpaid",
      path: "/unpaid",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "only", "only-key");

    const response = await runChat(harness.deps, chatInput("fast"));

    expect(response.status).toBe(502);
    expect(v.parse(ErrorSchema, await response.json()).error.code).toBe("unknown");
    expect(providerRowOf(harness.db, seeded.providerId)?.failures).toBe(0);
    expect(
      harness.db.select().from(providerModels).where(eq(providerModels.id, seeded.modelId)).get()
        ?.failures,
    ).toBe(0);
    expect(credentialNamed(harness.db, "only")?.failures).toBe(0);
    expect(harness.db.select().from(cooldownEvents).all()).toHaveLength(0);

    const events = requestEvents(harness.deps.duck);

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("error");
    expect(events[0]?.error_kind).toBe("unknown");
    expect(events[0]?.model).toBe("fast");
  });

  test("flags a model after a protocol failure and lets the next tag model answer", async () => {
    const harness = await freshHarness((call) => {
      // SAFETY: the fake upstream records the JSON body the openai adapter posts.
      const body = call.body as { model?: string };

      return body.model === "broken-model" ? Response.json({ unexpected: true }) : openAiSuccess();
    });

    const broken = await providerWithModel(harness, {
      name: "Broken",
      path: "/broken",
      slug: "broken",
      upstreamModel: "broken-model",
    });

    const spare = await providerWithModel(harness, {
      name: "Spare",
      path: "/spare",
      slug: "spare",
      upstreamModel: "spare-model",
    });

    await tagWith(harness, "failover", [broken.modelId, spare.modelId]);

    const response = await runChat(harness.deps, chatInput("tags/failover"));

    expect(response.status).toBe(200);
    expect(harness.upstream.calls.map((call) => call.path)).toEqual([
      "/broken/chat/completions",
      "/spare/chat/completions",
    ]);

    const modelRow = harness.db
      .select()
      .from(providerModels)
      .where(eq(providerModels.id, broken.modelId))
      .get();

    expect(modelRow?.failures).toBe(1);
    expect(modelRow?.flaggedUntil).not.toBeNull();
    expect(providerRowOf(harness.db, broken.providerId)?.failures).toBe(0);
  });

  test("falls through a model the upstream reports as missing", async () => {
    const harness = await freshHarness((call) => {
      // SAFETY: the fake upstream records the JSON body the openai adapter posts.
      const body = call.body as { model?: string };

      return body.model === "retired-model"
        ? Response.json({ error: { message: "model not found" } }, { status: 404 })
        : openAiSuccess();
    });

    const retired = await providerWithModel(harness, {
      name: "Retired",
      path: "/retired",
      slug: "retired",
      upstreamModel: "retired-model",
    });

    const current = await providerWithModel(harness, {
      name: "Current",
      path: "/current",
      slug: "current",
      upstreamModel: "current-model",
    });

    await tagWith(harness, "retired-chain", [retired.modelId, current.modelId]);

    const response = await runChat(harness.deps, chatInput("tags/retired-chain"));

    expect(response.status).toBe(200);
    expect(harness.upstream.calls.map((call) => call.path)).toEqual([
      "/retired/chat/completions",
      "/current/chat/completions",
    ]);

    const modelRow = harness.db
      .select()
      .from(providerModels)
      .where(eq(providerModels.id, retired.modelId))
      .get();

    expect(modelRow?.failures).toBe(1);
    expect(providerRowOf(harness.db, retired.providerId)?.failures).toBe(0);
  });

  test("probes the full plan when every subject is cooling and clears the flags", async () => {
    const harness = await freshHarness(() => openAiSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Cooling",
      path: "/cooling",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "only", "good-key");

    const credential = credentialNamed(harness.db, "only");
    const flaggedUntil = new Date(Date.now() + 60_000);

    harness.db
      .update(providers)
      .set({ failures: 2, flaggedUntil })
      .where(eq(providers.id, seeded.providerId))
      .run();
    harness.db
      .update(providerModels)
      .set({ failures: 2, flaggedUntil })
      .where(eq(providerModels.id, seeded.modelId))
      .run();
    harness.db
      .update(providerCredentials)
      .set({ failures: 2, flaggedUntil })
      .where(eq(providerCredentials.id, credential?.id ?? ""))
      .run();

    const response = await runChat(harness.deps, chatInput("fast"));

    expect(response.status).toBe(200);
    expect(harness.upstream.calls).toHaveLength(1);
    expect(providerRowOf(harness.db, seeded.providerId)?.failures).toBe(0);
    expect(providerRowOf(harness.db, seeded.providerId)?.flaggedUntil).toBeNull();
    expect(
      harness.db.select().from(providerModels).where(eq(providerModels.id, seeded.modelId)).get()
        ?.failures,
    ).toBe(0);
    expect(credentialNamed(harness.db, "only")?.failures).toBe(0);
    expect(credentialNamed(harness.db, "only")?.flaggedUntil).toBeNull();
  });

  test("streams from the next credential after an auth failure before any text", async () => {
    const harness = await freshHarness((call) =>
      call.key === "Bearer good-key"
        ? openAiStream()
        : Response.json({ error: { message: "bad key" } }, { status: 401 }),
    );

    const provider = await createProvider(harness.providers, "user-1", {
      name: "Primary",
      kind: "openai",
      baseUrl: harness.upstream.origin,
      apiKey: "",
    });

    await addProviderModel(harness.providers, "user-1", provider.id, {
      upstreamModel: "m",
      slug: "fast",
    });
    await addCredential(harness.providers, provider.id, "bad", "bad-key");
    await addCredential(harness.providers, provider.id, "good", "good-key");

    const response = await runChat(harness.deps, chatInput("fast", true));

    expect(response.status).toBe(200);

    const text = await response.text();

    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"content":" world"');
    expect(text).toContain("data: [DONE]");
    expect(harness.upstream.calls.map((call) => call.key)).toEqual([
      "Bearer bad-key",
      "Bearer good-key",
    ]);
    expect(credentialNamed(harness.db, "bad")?.failures).toBe(1);
  });
});

describe("runChat recording", () => {
  test("stores the project url the client sent", async () => {
    const harness = await freshHarness(() => openAiSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(
      harness.deps,
      chatInput("fast", false, "https://example.com/app"),
    );

    expect(response.status).toBe(200);
    expect(projectUrls(harness.deps.duck)).toEqual(["https://example.com/app"]);
  });

  test("leaves the project null when the client sends none", async () => {
    const harness = await freshHarness(() => openAiSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(harness.deps, chatInput("fast"));

    expect(response.status).toBe(200);
    expect(projectUrls(harness.deps.duck)).toEqual([null]);
  });

  test("stores the session id the client sent", async () => {
    const harness = await freshHarness(() => openAiSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(harness.deps, chatInput("fast", false, null, "session-alpha"));

    expect(response.status).toBe(200);
    expect(sessionIds(harness.deps.duck)).toEqual(["session-alpha"]);
  });

  test("leaves the session id null when the client sends none", async () => {
    const harness = await freshHarness(() => openAiSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(harness.deps, chatInput("fast"));

    expect(response.status).toBe(200);
    expect(sessionIds(harness.deps.duck)).toEqual([null]);
  });
});

describe("runChat usage normalization", () => {
  test("adds the cache tiers to a cached prompt in the OpenAI dialect", async () => {
    const harness = await freshHarness(() => anthropicSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Cached",
      kind: "anthropic",
      slug: "claude",
      upstreamModel: "claude-x",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(harness.deps, chatInput("claude"));

    expect(response.status).toBe(200);
    expect(v.parse(CompletionUsageSchema, await response.json()).usage).toEqual({
      prompt_tokens: 45,
      completion_tokens: 2,
      total_tokens: 47,
    });
    expect(cachedTokensOf(harness.deps.duck)).toEqual([30]);
  });

  test("reports only the non-cached prompt in the Anthropic dialect", async () => {
    const harness = await freshHarness(() => anthropicSuccess());

    const seeded = await providerWithModel(harness, {
      name: "Cached",
      kind: "anthropic",
      slug: "claude",
      upstreamModel: "claude-x",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(harness.deps, { ...chatInput("claude"), wire: anthropicWire });

    expect(response.status).toBe(200);
    expect(v.parse(MessageUsageSchema, await response.json()).usage).toEqual({
      input_tokens: 15,
      cache_read_input_tokens: 30,
      output_tokens: 2,
    });
  });

  test("keeps the cache read a streamed turn reports", async () => {
    const harness = await freshHarness(() => anthropicStream());

    const seeded = await providerWithModel(harness, {
      name: "Cached",
      kind: "anthropic",
      slug: "claude",
      upstreamModel: "claude-x",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    const response = await runChat(harness.deps, {
      ...chatInput("claude", true),
      wire: anthropicWire,
    });

    expect(response.status).toBe(200);

    const text = await response.text();

    expect(text).toContain('"input_tokens":15');
    expect(text).toContain('"cache_read_input_tokens":30');
    expect(cachedTokensOf(harness.deps.duck)).toEqual([30]);
  });
});

describe("chat ingress", () => {
  async function gatewayFor(harness: Harness) {
    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    return createGateway({ ...harness.deps, auth });
  }

  async function post(
    gateway: ReturnType<typeof createGateway>,
    body: ChatCompletionBody,
  ): Promise<Response> {
    const payload = v.parse(ChatCompletionRequestSchema, body);

    return gateway.handle(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bandar_test" },
        body: JSON.stringify(payload),
      }),
    );
  }

  test("accepts a pi content-part array and joins its text parts", async () => {
    const harness = await freshHarness(() => answer("hello"));

    const response = await post(await gatewayFor(harness), {
      model: "fast",
      messages: [
        { role: "system", content: "You are pi." },
        {
          role: "user",
          content: [
            { type: "text", text: "what is" },
            { type: "text", text: "2+2" },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(harness.upstream.calls[0]?.body).toMatchObject({
      messages: [
        { role: "system", content: "You are pi." },
        { role: "user", content: "what is\n2+2" },
      ],
    });
  });

  test("sends the developer role as system", async () => {
    const harness = await freshHarness(() => answer("hello"));

    const response = await post(await gatewayFor(harness), {
      model: "fast",
      messages: [
        { role: "developer", content: "You are pi." },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });

    expect(response.status).toBe(200);
    expect(harness.upstream.calls[0]?.body).toMatchObject({
      messages: [
        { role: "system", content: "You are pi." },
        { role: "user", content: "hi" },
      ],
    });
  });

  test("keeps reasoning_effort through the schema and onto the upstream body", async () => {
    const harness = await freshHarness(() => answer("hello"));

    const response = await post(await gatewayFor(harness), {
      model: "fast",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });

    expect(response.status).toBe(200);
    expect(harness.upstream.calls[0]?.body).toMatchObject({ reasoning_effort: "high" });
  });

  test("rejects a reasoning_effort the ladder does not carry", async () => {
    const harness = await freshHarness(() => answer("hello"));
    const gateway = await gatewayFor(harness);

    const response = await gateway.handle(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bandar_test" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "turbo",
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(harness.upstream.calls).toHaveLength(0);
  });

  test("rejects a non-text part at its path", async () => {
    const harness = await freshHarness(() => answer("hello"));

    const response = await post(await gatewayFor(harness), {
      model: "fast",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what is this" }, { type: "image_url" }],
        },
      ],
    });

    const body = v.parse(
      v.object({ error: v.object({ message: v.string(), param: v.nullable(v.string()) }) }),
      await response.json(),
    );

    expect(response.status).toBe(422);
    expect(body.error.param).toBe("messages.0.content.1");
    expect(body.error.message).toContain("image_url");
    expect(harness.upstream.calls).toHaveLength(0);
  });
});

describe("responses ingress", () => {
  async function gatewayFor(harness: Harness, compat: "responses" | null = null) {
    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "primary", "key");

    if (compat !== null) await setCompat(harness, seeded, compat);

    return createGateway({ ...harness.deps, auth });
  }

  function post(gateway: ReturnType<typeof createGateway>, body: JsonValue): Promise<Response> {
    return gateway.handle(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bandar_test" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function framed(gateway: ReturnType<typeof createGateway>, body: JsonValue) {
    const response = await post(gateway, body);

    return { status: response.status, frames: responsesFrames(await response.text()) };
  }

  test("answers a non-streamed text turn", async () => {
    const harness = await freshHarness(() => answer("hello"));

    const response = await post(await gatewayFor(harness), {
      model: "fast",
      input: "what is 2+2?",
    });

    expect(response.status).toBe(200);

    const body = v.parse(ResponseBodySchema, await response.json());

    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    });
    expect(body.usage.input_tokens).toBe(1);
    expect(body.error).toBeNull();
    expect(body.incomplete_details).toBeNull();
  });

  test("answers an empty turn with one empty message, the way bandar itself reads a reply", async () => {
    const harness = await freshHarness(() =>
      Response.json({
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );

    const response = await post(await gatewayFor(harness), { model: "fast", input: "hi" });
    const body = v.parse(ResponseBodySchema, await response.json());

    expect(response.status).toBe(200);
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(body.output).toEqual([
      {
        id: body.output[0]?.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      },
    ]);
  });

  test("streams the frames a Responses client reads, in order and numbered once", async () => {
    const harness = await freshHarness(() => openAiStream());

    const { status, frames } = await framed(await gatewayFor(harness), {
      model: "fast",
      input: "hi",
      stream: true,
    });

    expect(status).toBe(200);
    expect(frames.map((frame) => frame.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
      "[DONE]",
    ]);
    expect(frames.slice(0, 9).map((frame) => frame.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    const text = frames
      .filter((frame) => frame.type === "response.output_text.delta")
      .map((frame) => frame.delta)
      .join("");

    expect(text).toBe("hello world");
  });

  test("creates the response only once an upstream answers, so a rate limit still fails over", async () => {
    const harness = await freshHarness((call) =>
      call.key === "Bearer good-key"
        ? openAiStream()
        : Response.json({ error: { message: "slow down" } }, { status: 429 }),
    );

    const seeded = await providerWithModel(harness, {
      name: "Primary",
      path: "",
      slug: "fast",
      upstreamModel: "m",
    });

    await addCredential(harness.providers, seeded.providerId, "limited", "limited-key");
    await addCredential(harness.providers, seeded.providerId, "good", "good-key");

    const { status, frames } = await framed(createGateway({ ...harness.deps, auth }), {
      model: "fast",
      input: "hi",
      stream: true,
    });

    expect(status).toBe(200);
    expect(frames.map((frame) => frame.type)).not.toContain("response.failed");
    expect(frames.filter((frame) => frame.type === "response.created")).toHaveLength(1);
    expect(harness.upstream.calls.map((call) => call.key)).toEqual([
      "Bearer limited-key",
      "Bearer good-key",
    ]);
  });

  test("carries a Codex-shaped turn onto the upstream body", async () => {
    const harness = await freshHarness(() => answer("a list"));

    const response = await post(await gatewayFor(harness), {
      model: "fast",
      instructions: "be brief",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list ./src" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"./src"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "chat.ts" },
      ],
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      tool_choice: "auto",
      max_output_tokens: 64,
      reasoning: { effort: "high" },
    });

    expect(response.status).toBe(200);
    expect(harness.upstream.calls[0]?.body).toMatchObject({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "list ./src" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"./src"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "chat.ts" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "auto",
      max_tokens: 64,
      reasoning_effort: "high",
    });
  });

  test("streams a tool call as an output item with its arguments", async () => {
    const harness = await freshHarness(() =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"' + './src"}' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]),
    );

    const { frames } = await framed(await gatewayFor(harness), {
      model: "fast",
      input: "list ./src",
      stream: true,
      tools: [{ type: "function", name: "read_file" }],
    });

    const opened = frames.find(
      (frame) =>
        frame.type === "response.output_item.added" && frame.item?.type === "function_call",
    );

    expect(opened?.item).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: "",
    });
    expect(opened?.output_index).toBe(0);
    expect(frames.some((frame) => frame.item?.type === "message")).toBe(false);

    const done = frames.find((frame) => frame.type === "response.function_call_arguments.done");

    expect(done?.arguments).toBe('{"path":"./src"}');
    expect(done?.item_id).toBe(opened?.item?.id);

    const closed = frames.find(
      (frame) => frame.type === "response.output_item.done" && frame.item?.type === "function_call",
    );

    expect(closed?.item).toMatchObject({ call_id: "call_1", arguments: '{"path":"./src"}' });
    expect(
      frames
        .filter((frame) => frame.type === "response.function_call_arguments.delta")
        .map((frame) => frame.delta)
        .join(""),
    ).toBe('{"path":"./src"}');
  });

  test("closes a call that streamed no argument deltas with the whole arguments", async () => {
    const harness = await freshHarness(() =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"./src"}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]),
    );

    const { frames } = await framed(await gatewayFor(harness), {
      model: "fast",
      input: "list ./src",
      stream: true,
      tools: [{ type: "function", name: "read_file" }],
    });

    expect(frames.map((frame) => frame.type)).toContain("response.function_call_arguments.done");
    expect(
      frames.find((frame) => frame.type === "response.function_call_arguments.done")?.arguments,
    ).toBe('{"path":"./src"}');
  });

  test("keeps reasoning.effort on a request answered by the Responses wire upstream", async () => {
    const harness = await freshHarness(() =>
      Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const response = await post(await gatewayFor(harness, "responses"), {
      model: "fast",
      input: "hi",
      reasoning: { effort: "high", summary: "auto" },
    });

    expect(response.status).toBe(200);
    expect(harness.upstream.calls[0]?.body).toMatchObject({
      reasoning: { effort: "high" },
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
  });

  test("rejects an input item type and a reasoning effort the ladder lacks, and answers 401 with no key", async () => {
    const harness = await freshHarness(() => answer("hello"));
    const gateway = await gatewayFor(harness);

    const item = await post(gateway, {
      model: "fast",
      input: [
        { role: "user", content: "hi" },
        { type: "input_image", image_url: "x" },
      ],
    });

    expect(item.status).toBe(422);

    const itemBody = v.parse(
      v.object({ error: v.object({ message: v.string(), param: v.nullable(v.string()) }) }),
      await item.json(),
    );

    expect(itemBody.error.param).toBe("input.1.type");
    expect(itemBody.error.message).toBe(
      "input.1.type: input_image items are not part of this gateway",
    );

    const effort = await post(gateway, {
      model: "fast",
      input: "hi",
      reasoning: { effort: "turbo" },
    });

    expect(effort.status).toBe(422);
    expect(
      v.parse(v.object({ error: v.object({ param: v.nullable(v.string()) }) }), await effort.json())
        .error.param,
    ).toBe("reasoning.effort");

    const anonymous = await gateway.handle(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fast", input: "hi" }),
      }),
    );

    expect(anonymous.status).toBe(401);
    expect(harness.upstream.calls).toHaveLength(0);
  });

  test("reports every declared CLI tool as ready now that the responses route is served", () => {
    expect(toolStatus(toolById("codex")).status).toBe("ready");
  });
});

const auth = {
  handler: () => Promise.resolve(new Response(null)),
  getSession: () => Promise.resolve(null),
  verifyApiKey: () => Promise.resolve({ userId: "user-1", keyId: "key-1" }),
} satisfies Auth;

function chatInput(
  ref: string,
  stream = false,
  projectUrl: string | null = null,
  sessionId: string | null = null,
): ChatInput {
  return {
    userId: "user-1",
    apiKeyId: "key-1",
    projectUrl,
    sessionId,
    ref,
    request: {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      toolChoice: null,
    },
    stream,
    signal: new AbortController().signal,
  };
}

async function freshHarness(
  handle: (call: Call) => Response | Promise<Response>,
): Promise<Harness> {
  const upstream = startUpstream(handle);
  const database = openDatabase(":memory:");

  applyMigrations(database.sqlite, migrations());
  database.db.insert(user).values({ id: "user-1", name: "User", email: "user@test" }).run();

  const duck = new DuckDb(":memory:", DUCK_LIB);

  applyDuckMigrations(duck, duckMigrations());

  const sealer = await createSealer("test-secret");

  const providers = {
    db: database.db,
    sealer,
    endpoints: DEFAULT_PROVIDER_ENDPOINTS,
  } satisfies ProviderDeps;

  cleanup.push(
    () => upstream.stop(),
    () => database.sqlite.close(),
    () => duck.close(),
  );

  return { deps: { duck, providers }, providers, db: database.db, upstream };
}

function startUpstream(handle: (call: Call) => Response | Promise<Response>): Upstream {
  const calls: Call[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      const call: Call = {
        path: url.pathname,
        key: request.headers.get("authorization"),
        body: await request.json(),
      };

      calls.push(call);

      return handle(call);
    },
  });

  return {
    origin: "http://127.0.0.1:" + String(server.port),
    calls,
    stop: () => void server.stop(true),
  };
}

function openAiUpstream(key: string) {
  return (call: Call): Response =>
    call.key === "Bearer " + key
      ? openAiSuccess()
      : Response.json({ error: { message: "bad key" } }, { status: 401 });
}

function openAiSuccess(): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
}

function anthropicSuccess(): Response {
  return Response.json({
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    },
  });
}

function anthropicStream(): Response {
  return sse([
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 5,
        },
      },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);
}

function openAiStream(): Response {
  return sse([
    { choices: [{ delta: { content: "hello" } }] },
    {
      choices: [{ delta: { content: " world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
    "[DONE]",
  ]);
}

function sse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);

          controller.enqueue(encoder.encode("data: " + data + "\n\n"));
        }

        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type Seeded = { readonly providerId: string; readonly modelId: string };

function requestEvents(duck: DuckDb): readonly QueryRow[] {
  return duck.query(
    "SELECT status, error_kind, http_status, reference, model, project_url FROM request_events ORDER BY started_at",
  );
}

function cachedTokensOf(duck: DuckDb): readonly (number | null)[] {
  return duck
    .query("SELECT cached_input_tokens FROM request_events ORDER BY started_at")
    .map((row) =>
      row.cached_input_tokens === null || row.cached_input_tokens === undefined
        ? null
        : Number(row.cached_input_tokens),
    );
}

function projectUrls(duck: DuckDb): readonly (string | null)[] {
  return duck
    .query("SELECT project_url FROM request_events ORDER BY started_at")
    .map((row) =>
      row.project_url === null || row.project_url === undefined ? null : String(row.project_url),
    );
}

function sessionIds(duck: DuckDb): readonly (string | null)[] {
  return duck
    .query("SELECT session_id FROM request_events ORDER BY started_at")
    .map((row) =>
      row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    );
}

describe("built-in provider endpoints", () => {
  test("the config base URL outranks the seeded row on a gateway request", async () => {
    const stale = startUpstream(() => answer("stale"));
    const live = startUpstream(() => answer("live"));
    const harness = await freshHarness(() => openAiSuccess());

    cleanup.push(stale.stop, live.stop);

    const staleEndpoints = {
      ...DEFAULT_PROVIDER_ENDPOINTS,
      tokenharbor: { ...DEFAULT_PROVIDER_ENDPOINTS.tokenharbor, baseUrl: stale.origin },
    };

    const staleProviders: ProviderDeps = { ...harness.providers, endpoints: staleEndpoints };

    await ensureBuiltInProviders(staleProviders, "user-1");

    const row = harness.db.select().from(providers).where(eq(providers.kind, "tokenharbor")).get();

    if (row === undefined) throw new Error("tokenharbor was not seeded");

    expect(row.baseUrl).toBe(stale.origin);

    await addProviderModel(staleProviders, "user-1", row.id, {
      upstreamModel: "m",
      slug: "builtin-fast",
    });
    await addCredential(staleProviders, row.id, "builtin-key", "key");

    stale.calls.length = 0;
    live.calls.length = 0;

    const liveEndpoints = {
      ...staleEndpoints,
      tokenharbor: { ...staleEndpoints.tokenharbor, baseUrl: live.origin },
    };

    const liveProviders: ProviderDeps = { ...harness.providers, endpoints: liveEndpoints };

    const response = await runChat(
      { ...harness.deps, providers: liveProviders },
      chatInput("builtin-fast"),
    );

    expect(response.status).toBe(200);
    expect(v.parse(CompletionSchema, await response.json()).choices[0]?.message.content).toBe(
      "live",
    );
    expect(live.calls).toHaveLength(1);
    expect(stale.calls).toHaveLength(0);
  });
});

function answer(content: string): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
}

function deadOrigin(): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const origin = `http://127.0.0.1:${String(server.port)}`;

  void server.stop(true);

  return origin;
}

async function providerWithModel(
  harness: Harness,
  options: {
    readonly name: string;
    readonly path?: string;
    readonly slug: string;
    readonly upstreamModel: string;
    readonly origin?: string;
    readonly kind?: GenericProviderKind;
  },
): Promise<Seeded> {
  const provider = await createProvider(harness.providers, "user-1", {
    name: options.name,
    kind: options.kind ?? "openai",
    baseUrl: (options.origin ?? harness.upstream.origin) + (options.path ?? ""),
    apiKey: "",
  });

  const updated = await addProviderModel(harness.providers, "user-1", provider.id, {
    upstreamModel: options.upstreamModel,
    slug: options.slug,
  });

  const modelId = updated?.models.find((model) => model.slug === options.slug)?.id ?? "";

  expect(modelId).not.toBe("");

  return { providerId: provider.id, modelId };
}

async function addCredential(
  deps: ProviderDeps,
  providerId: string,
  label: string,
  apiKey: string,
): Promise<void> {
  const added = await addProviderCredential(deps, "user-1", providerId, { label, apiKey });

  if (added.kind !== "ok") throw new Error(`adding a credential failed: ${added.kind}`);
}

async function tagWith(harness: Harness, slug: string, modelIds: readonly string[]): Promise<void> {
  const list = await createTag(harness.providers, "user-1", slug);
  const tag = list.tags.find((entry) => entry.slug === slug);

  expect(tag).toBeDefined();

  await setTagModels(harness.providers, "user-1", tag?.id ?? "", modelIds);
}

function credentialNamed(db: Harness["db"], label: string) {
  return db.select().from(providerCredentials).where(eq(providerCredentials.label, label)).get();
}

function providerRowOf(db: Harness["db"], id: string) {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

function migrations(): readonly Migration[] {
  return readdirSync(SQLITE_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ tag: name.slice(0, -4), sql: readFileSync(join(SQLITE_DIR, name), "utf8") }));
}

function duckMigrations() {
  return readdirSync(DUCK_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ tag: name.slice(0, -4), sql: readFileSync(join(DUCK_DIR, name), "utf8") }));
}

type ResponsesFrame = {
  readonly type: string;
  readonly sequence_number?: number;
  readonly output_index?: number;
  readonly item_id?: string;
  readonly delta?: string;
  readonly arguments?: string;
  readonly item?: {
    readonly id: string;
    readonly type: string;
    readonly call_id?: string;
    readonly name?: string;
    readonly arguments?: string;
  };
};

function responsesFrames(text: string): readonly ResponsesFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block): ResponsesFrame => {
      const data = block.replace(/^data: /u, "");

      const parsed: unknown = data === "[DONE]" ? { type: "[DONE]" } : JSON.parse(data);

      return v.parse(v.looseObject({ type: v.string() }), parsed);
    });
}

async function setCompat(harness: Harness, seeded: Seeded, compat: "responses"): Promise<void> {
  await updateProviderModel(harness.providers, "user-1", seeded.providerId, seeded.modelId, {
    slug: "fast",
    alias: null,
    compat,
    inputPricePerMtok: null,
    cacheInputPricePerMtok: null,
    outputPricePerMtok: null,
  });
}
