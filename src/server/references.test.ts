import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { ChatCompletionRequestSchema } from "../shared/chat";
import {
  MAX_MODEL_REF_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_UPSTREAM_MODEL_LENGTH,
  providerRefOf,
} from "../shared/slugs";
import { user } from "./db/auth-schema";
import { openDatabase, type DatabaseHandle } from "./db/client";
import { applyMigrations, type Migration } from "./db/migrate";
import { providerModels, providers, tagModels, tags } from "./db/schema";
import {
  addProviderModel,
  createProvider,
  listProviders,
  ProviderRuleError,
  removeProviderModel,
  updateProvider,
  type ProviderDeps,
} from "./providers";
import { createSealer } from "./seal";
import { createTag, listTags, setTagModels } from "./tags";

const SQLITE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

let open: DatabaseHandle[] = [];

afterEach(() => {
  for (const handle of open) handle.sqlite.close();
  open = [];
});

describe("model refs", () => {
  test("the longest provider ref fits the gateway model field", () => {
    const ref = providerRefOf("s".repeat(MAX_SLUG_LENGTH), "m".repeat(MAX_UPSTREAM_MODEL_LENGTH));

    expect(ref).toHaveLength(MAX_MODEL_REF_LENGTH);

    const accepted = v.safeParse(ChatCompletionRequestSchema, {
      model: ref,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(accepted.success).toBe(true);

    const rejected = v.safeParse(ChatCompletionRequestSchema, {
      model: `${ref}x`,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(rejected.success).toBe(false);
  });
});

describe("provider models", () => {
  test("a provider rejects a second model with the same upstream", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Custom",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addProviderModel(deps, "user-1", provider.id, { upstreamModel: "same", alias: "one" });

    await expect(
      addProviderModel(deps, "user-1", provider.id, { upstreamModel: "same", alias: "two" }),
    ).rejects.toThrow(ProviderRuleError);
  });

  test("deleting a model renumbers the remaining tag priorities", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Custom",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addProviderModel(deps, "user-1", provider.id, { upstreamModel: "one", alias: "one" });
    await addProviderModel(deps, "user-1", provider.id, { upstreamModel: "two", alias: "two" });

    const models =
      (await listProviders(deps, "user-1")).providers.find((entry) => entry.id === provider.id)
        ?.models ?? [];

    const created = await createTag(deps, "user-1", "chain");
    const tagId = created.tags.find((tag) => tag.slug === "chain")?.id ?? "";

    await setTagModels(
      deps,
      "user-1",
      tagId,
      models.map((model) => model.id),
    );
    await removeProviderModel(deps, "user-1", provider.id, models[0]?.id ?? "");

    const chain = (await listTags(deps, "user-1")).tags.find((tag) => tag.slug === "chain");

    expect(chain?.models.map((model) => model.priority)).toEqual([1]);
  });

  test("migration 0007 collapses duplicate upstream rows", () => {
    const handle = openDatabase(":memory:");
    open.push(handle);

    const all = migrations();

    applyMigrations(
      handle.sqlite,
      all.filter((migration) => migration.tag < "0007"),
    );

    handle.db.insert(user).values({ id: "user-1", name: "User", email: "user-1@test" }).run();
    handle.db
      .insert(providers)
      .values({
        id: "provider-1",
        userId: "user-1",
        name: "Provider",
        slug: "provider",
        kind: "openai",
        baseUrl: "https://example.com",
        apiKey: "",
        authMode: "api-key",
        origin: "custom",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })
      .run();
    handle.db
      .insert(providerModels)
      .values([
        {
          id: "model-1",
          userId: "user-1",
          providerId: "provider-1",
          alias: "one",
          upstreamModel: "same",
          enabled: true,
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: "model-2",
          userId: "user-1",
          providerId: "provider-1",
          alias: "two",
          upstreamModel: "same",
          enabled: true,
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      ])
      .run();
    handle.db
      .insert(tags)
      .values([
        {
          id: "tag-both",
          userId: "user-1",
          slug: "both",
          createdAt: new Date("2026-01-04T00:00:00.000Z"),
        },
        {
          id: "tag-second",
          userId: "user-1",
          slug: "second",
          createdAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      ])
      .run();
    handle.db
      .insert(tagModels)
      .values([
        { tagId: "tag-both", modelId: "model-1", priority: 1 },
        { tagId: "tag-both", modelId: "model-2", priority: 2 },
        { tagId: "tag-second", modelId: "model-2", priority: 1 },
      ])
      .run();

    expect(applyMigrations(handle.sqlite, all).applied).toEqual(["0007_provider_upstream"]);
    expect(handle.db.select({ id: providerModels.id }).from(providerModels).all()).toEqual([
      { id: "model-1" },
    ]);

    const links = handle.db
      .select({ tagId: tagModels.tagId, modelId: tagModels.modelId, priority: tagModels.priority })
      .from(tagModels)
      .all()
      .map((link) => `${link.tagId}:${link.modelId}:${String(link.priority)}`)
      .sort();

    expect(links).toEqual(["tag-both:model-1:1", "tag-second:model-1:1"]);
    expect(() =>
      handle.db
        .insert(providerModels)
        .values({
          id: "model-3",
          userId: "user-1",
          providerId: "provider-1",
          alias: "three",
          upstreamModel: "same",
          enabled: true,
          createdAt: new Date("2026-01-06T00:00:00.000Z"),
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe("provider updates", () => {
  test("a built-in provider accepts its own slug", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const builtIn = (await listProviders(deps, "user-1")).providers.find(
      (provider) => provider.origin === "builtin",
    );

    if (builtIn === undefined) throw new Error("the built-in provider is missing");

    const updated = await updateProvider(deps, "user-1", builtIn.id, {
      name: builtIn.name,
      kind: builtIn.kind,
      baseUrl: builtIn.baseUrl,
      apiKey: "",
      slug: builtIn.slug,
    });

    expect(updated?.slug).toBe("kilo");
  });
});

function migrations(): readonly Migration[] {
  return readdirSync(SQLITE_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ tag: name.slice(0, -4), sql: readFileSync(join(SQLITE_DIR, name), "utf8") }));
}

function freshDb(): DatabaseHandle {
  const handle = openDatabase(":memory:");
  open.push(handle);
  applyMigrations(handle.sqlite, migrations());
  handle.db.insert(user).values({ id: "user-1", name: "User", email: "user-1@test" }).run();

  return handle;
}

function providerDeps(handle: DatabaseHandle): Promise<ProviderDeps> {
  return createSealer("test-secret").then((sealer) => ({ db: handle.db, sealer }));
}
