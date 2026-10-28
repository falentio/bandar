import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { ChatCompletionRequestSchema } from "../shared/chat";
import type { Provider } from "../shared/providers";
import {
  MAX_MODEL_REF_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_UPSTREAM_MODEL_LENGTH,
  providerRefOf,
} from "../shared/slugs";
import { user } from "./db/auth-schema";
import { openDatabase, type DatabaseHandle } from "./db/client";
import { applyMigrations, type Migration } from "./db/migrate";
import { providerCredentials, providerModels, providers, tagModels, tags } from "./db/schema";
import {
  addProviderModel,
  createProvider,
  listProviders,
  ProviderRuleError,
  readCredential,
  removeProvider,
  removeProviderModel,
  updateProvider,
  updateProviderModel,
  type ProviderDeps,
} from "./providers";
import { assignProviderSlugs } from "./providers/seeding";
import {
  addProviderCredential,
  addProviderCredentials,
  removeProviderCredential,
  reorderProviderCredentials,
} from "./credentials";
import { listModelRefs, resolvePlan } from "./router/resolve";
import { createSealer } from "./seal";
import { createTag, listTags, setTagModels } from "./tags";

const SQLITE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

let open: DatabaseHandle[] = [];

afterEach(() => {
  for (const handle of open) handle.sqlite.close();
  open = [];
});

const INSERT_PROVIDER_SQL =
  "INSERT INTO providers (id, user_id, name, slug, kind, base_url, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const INSERT_MODEL_SQL =
  "INSERT INTO provider_models (id, user_id, provider_id, alias, upstream_model, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

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

describe("references", () => {
  test("resolution is case-sensitive", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Case",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addProviderModel(deps, "user-1", provider.id, {
      upstreamModel: "Model",
      alias: "Alias",
    });

    expect((await resolvePlan(deps, "user-1", "case/Model")).attempts).toHaveLength(1);
    expect((await resolvePlan(deps, "user-1", "CASE/Model")).attempts).toHaveLength(0);
    expect((await resolvePlan(deps, "user-1", "Alias")).attempts).toHaveLength(1);
    expect((await resolvePlan(deps, "user-1", "alias")).attempts).toHaveLength(0);
  });

  test("a legacy tags/ alias wins over the tag chain", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const aliasProvider = await createProvider(deps, "user-1", {
      name: "Alias",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    handle.db
      .insert(providerModels)
      .values({
        id: "legacy-alias",
        userId: "user-1",
        providerId: aliasProvider.id,
        alias: "tags/legacy",
        upstreamModel: "alias-model",
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })
      .run();

    const tagProvider = await createProvider(deps, "user-1", {
      name: "Tag Source",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const tagProviderWithModel = await addProviderModel(deps, "user-1", tagProvider.id, {
      upstreamModel: "tag-model",
      alias: "tag-model",
    });

    const tagModel = tagProviderWithModel?.models.find((model) => model.alias === "tag-model");
    const created = await createTag(deps, "user-1", "legacy");
    const tagId = created.tags.find((tag) => tag.slug === "legacy")?.id ?? "";

    await setTagModels(deps, "user-1", tagId, [tagModel?.id ?? ""]);

    const plan = await resolvePlan(deps, "user-1", "tags/legacy");

    expect(plan.tag).toBeNull();
    expect(plan.attempts.map((attempt) => attempt.upstreamModel)).toEqual(["alias-model"]);
  });

  test("a shadowed provider ref appears once in the model list", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const alpha = await createProvider(deps, "user-1", {
      name: "Alpha",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const beta = await createProvider(deps, "user-1", {
      name: "Beta",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addProviderModel(deps, "user-1", alpha.id, { upstreamModel: "m", alias: "m" });
    await addProviderModel(deps, "user-1", beta.id, {
      upstreamModel: "x",
      alias: "alpha/m",
    });

    const refs = await listModelRefs(deps, "user-1");

    expect(refs.filter((ref) => ref.id === "alpha/m")).toHaveLength(1);

    const alphaModel = (await listProviders(deps, "user-1")).providers
      .find((provider) => provider.id === alpha.id)
      ?.models.find((model) => model.upstreamModel === "m");

    expect(alphaModel?.shadowed).toBe(true);
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

  test("a kind change keeps an override the new kind cannot serve", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Custom",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const withModel = await addProviderModel(deps, "user-1", provider.id, {
      upstreamModel: "gpt-4o",
      alias: "fast",
    });

    const modelId = withModel?.models.find((model) => model.alias === "fast")?.id ?? "";

    await updateProviderModel(deps, "user-1", provider.id, modelId, {
      alias: "fast",
      compat: "responses",
      inputPricePerMtok: null,
      cacheInputPricePerMtok: null,
      outputPricePerMtok: null,
    });

    await updateProvider(deps, "user-1", provider.id, {
      name: "Custom",
      kind: "anthropic",
      baseUrl: "https://example.com",
    });

    const after = (await listProviders(deps, "user-1")).providers.find(
      (entry) => entry.id === provider.id,
    );

    expect(after?.compats).toEqual(["messages"]);
    expect(after?.models[0]?.compat).toBe("responses");
    expect(after?.models[0]?.defaultCompat).toBe("messages");
  });

  test("an edit renames a model and sets its prices", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Custom",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const withModel = await addProviderModel(deps, "user-1", provider.id, {
      upstreamModel: "gpt-4o-mini",
    });

    const modelId = withModel?.models[0]?.id ?? "";

    const edited = await updateProviderModel(deps, "user-1", provider.id, modelId, {
      alias: "gpt-4o-mini-fast",
      compat: null,
      inputPricePerMtok: 0.15,
      cacheInputPricePerMtok: 0.0031,
      outputPricePerMtok: 0.6,
    });

    expect(edited?.models[0]?.alias).toBe("gpt-4o-mini-fast");
    expect(edited?.models[0]?.inputPricePerMtok).toBe(0.15);
    expect(edited?.models[0]?.outputPricePerMtok).toBe(0.6);
    expect(edited?.models[0]?.upstreamModel).toBe("gpt-4o-mini");
  });

  test("an edit refuses an alias another model holds", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Custom",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addProviderModel(deps, "user-1", provider.id, { upstreamModel: "one", alias: "first" });

    const withSecond = await addProviderModel(deps, "user-1", provider.id, {
      upstreamModel: "two",
      alias: "second",
    });

    const secondId = withSecond?.models.find((model) => model.alias === "second")?.id ?? "";

    await expect(
      updateProviderModel(deps, "user-1", provider.id, secondId, {
        alias: "first",
        compat: null,
        inputPricePerMtok: null,
        cacheInputPricePerMtok: null,
        outputPricePerMtok: null,
      }),
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

  test("deleting a provider removes its models and renumbers tags", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const first = await createProvider(deps, "user-1", {
      name: "First",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const second = await createProvider(deps, "user-1", {
      name: "Second",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const firstModel = await addProviderModel(deps, "user-1", first.id, {
      upstreamModel: "first",
      alias: "first",
    });

    const secondModel = await addProviderModel(deps, "user-1", second.id, {
      upstreamModel: "second",
      alias: "second",
    });

    const created = await createTag(deps, "user-1", "chain");
    const tagId = created.tags.find((tag) => tag.slug === "chain")?.id ?? "";

    await setTagModels(deps, "user-1", tagId, [
      firstModel?.models.find((model) => model.alias === "first")?.id ?? "",
      secondModel?.models.find((model) => model.alias === "second")?.id ?? "",
    ]);

    expect(await removeProvider(deps, "user-1", first.id)).toBe(true);

    const chain = (await listTags(deps, "user-1")).tags.find((tag) => tag.slug === "chain");

    expect(chain?.models.map((model) => [model.alias, model.priority])).toEqual([["second", 1]]);
    expect(
      handle.db
        .select({ id: providerModels.id })
        .from(providerModels)
        .where(eq(providerModels.providerId, first.id))
        .all(),
    ).toEqual([]);
  });

  test("the slug backfill is idempotent", async () => {
    const handle = freshDb();
    const rows = ["Kilo", "Tags", "Same", "Same 2"];

    handle.db
      .insert(providers)
      .values(
        rows.map((name, index) => ({
          id: `provider-${String(index)}`,
          userId: "user-1",
          name,
          slug: "",
          kind: "openai" as const,
          baseUrl: "https://example.com",
          origin: "custom" as const,
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        })),
      )
      .run();

    expect(await assignProviderSlugs(handle.db)).toBe(4);
    expect(await assignProviderSlugs(handle.db)).toBe(0);

    const slugs = handle.db
      .select({ slug: providers.slug })
      .from(providers)
      .all()
      .map((row) => row.slug)
      .sort();

    expect(slugs).toEqual(["kilo-2", "same", "same-2", "tags-2"]);
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
    handle.sqlite
      .query(INSERT_PROVIDER_SQL)
      .run(
        "provider-1",
        "user-1",
        "Provider",
        "provider",
        "openai",
        "https://example.com",
        "custom",
        Date.parse("2026-01-01T00:00:00.000Z"),
      );
    handle.sqlite
      .query(INSERT_MODEL_SQL)
      .run(
        "model-1",
        "user-1",
        "provider-1",
        "one",
        "same",
        1,
        Date.parse("2026-01-02T00:00:00.000Z"),
      );
    handle.sqlite
      .query(INSERT_MODEL_SQL)
      .run(
        "model-2",
        "user-1",
        "provider-1",
        "two",
        "same",
        1,
        Date.parse("2026-01-03T00:00:00.000Z"),
      );
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

    expect(
      applyMigrations(
        handle.sqlite,
        all.filter((migration) => migration.tag < "0008"),
      ).applied,
    ).toEqual(["0007_provider_upstream"]);
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
      handle.sqlite
        .query(INSERT_MODEL_SQL)
        .run(
          "model-3",
          "user-1",
          "provider-1",
          "three",
          "same",
          1,
          Date.parse("2026-01-06T00:00:00.000Z"),
        ),
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
      slug: builtIn.slug,
    });

    expect(updated?.slug).toBe("kilo");
  });
});

describe("provider credentials", () => {
  test("an alias and a provider ref expand to one attempt per credential", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Multi",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addCredential(deps, provider.id, "first-key", "work");

    const keyed = await addCredential(deps, provider.id, "second-key");

    await addProviderModel(deps, "user-1", provider.id, { upstreamModel: "gpt", alias: "fast" });

    const ids = keyed.credentials.map((credential) => credential.id);

    expect(ids).toHaveLength(2);
    expect(
      (await resolvePlan(deps, "user-1", "fast")).attempts.map((attempt) => attempt.credentialId),
    ).toEqual(ids);
    expect(
      (await resolvePlan(deps, "user-1", "multi/gpt")).attempts.map(
        (attempt) => attempt.credentialId,
      ),
    ).toEqual(ids);
  });

  test("a tag walks one model's credentials before the next model", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const alpha = await createProvider(deps, "user-1", {
      name: "Alpha",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addCredential(deps, alpha.id, "alpha-first");

    const alphaKeyed = await addCredential(deps, alpha.id, "alpha-second");

    const beta = await createProvider(deps, "user-1", {
      name: "Beta",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const betaKeyed = await addCredential(deps, beta.id, "beta-first");

    const alphaModel = await addProviderModel(deps, "user-1", alpha.id, {
      upstreamModel: "a",
      alias: "a",
    });

    const betaModel = await addProviderModel(deps, "user-1", beta.id, {
      upstreamModel: "b",
      alias: "b",
    });

    const created = await createTag(deps, "user-1", "chain");
    const tagId = created.tags.find((tag) => tag.slug === "chain")?.id ?? "";

    await setTagModels(deps, "user-1", tagId, [
      alphaModel?.models.find((model) => model.alias === "a")?.id ?? "",
      betaModel?.models.find((model) => model.alias === "b")?.id ?? "",
    ]);

    const plan = await resolvePlan(deps, "user-1", "tags/chain");

    expect(plan.attempts.map((attempt) => [attempt.alias, attempt.credentialId])).toEqual([
      ["a", alphaKeyed.credentials[0]?.id],
      ["a", alphaKeyed.credentials[1]?.id],
      ["b", betaKeyed.credentials[0]?.id],
    ]);
  });

  test("a provider with no credentials resolves to one keyless attempt", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Local",
      kind: "openai",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
    });

    await addProviderModel(deps, "user-1", provider.id, { upstreamModel: "local", alias: "local" });

    const attempt = (await resolvePlan(deps, "user-1", "local")).attempts[0];

    if (attempt === undefined) throw new Error("the keyless provider did not resolve");

    expect(attempt.credentialId).toBeNull();
    expect(attempt.sealedKey).toBe("");
    expect(await readCredential(deps, attempt.sealedKey)).toEqual({
      authMode: "api-key",
      apiKey: "",
    });
  });

  test("a credential from another provider or account is rejected", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    handle.db.insert(user).values({ id: "user-2", name: "Other", email: "user-2@test" }).run();

    const alpha = await createProvider(deps, "user-1", {
      name: "Alpha",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const beta = await createProvider(deps, "user-1", {
      name: "Beta",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    const keyed = await addCredential(deps, alpha.id, "alpha-key");
    const credentialId = keyed.credentials[0]?.id ?? "";

    expect((await removeProviderCredential(deps, "user-1", beta.id, credentialId)).kind).toBe(
      "missing_credential",
    );
    expect((await reorderProviderCredentials(deps, "user-1", beta.id, [credentialId])).kind).toBe(
      "invalid_order",
    );
    expect((await addProviderCredential(deps, "user-2", alpha.id, { apiKey: "x" })).kind).toBe(
      "missing_provider",
    );
    expect(
      (await listProviders(deps, "user-1")).providers.find((provider) => provider.id === alpha.id)
        ?.credentials,
    ).toEqual([
      {
        id: credentialId,
        label: "",
        authMode: "api-key",
        priority: 1,
        failures: 0,
        flaggedUntil: null,
        createdAt: keyed.credentials[0]?.createdAt,
      },
    ]);
  });

  test("a reorder rejects a duplicate id and lands a real permutation", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Dup",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addCredential(deps, provider.id, "one");
    const keyed = await addCredential(deps, provider.id, "two");

    const ids = keyed.credentials.map((credential) => credential.id);
    const first = ids[0] ?? "";
    const second = ids[1] ?? "";

    expect(
      (await reorderProviderCredentials(deps, "user-1", provider.id, [first, first])).kind,
    ).toBe("invalid_order");
    expect(
      (await reorderProviderCredentials(deps, "user-1", provider.id, [second, first])).kind,
    ).toBe("ok");
  });

  test("removing a middle credential compacts the ranks", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Middle",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    await addCredential(deps, provider.id, "one");
    await addCredential(deps, provider.id, "two");
    const all = await addCredential(deps, provider.id, "three");

    const ids = all.credentials.map((credential) => credential.id);

    const removed = await removeProviderCredential(deps, "user-1", provider.id, ids[1] ?? "");

    if (removed.kind !== "ok") throw new Error("the middle credential was not removed");

    expect(
      removed.provider.credentials.map((credential) => [credential.id, credential.priority]),
    ).toEqual([
      [ids[0], 1],
      [ids[2], 2],
    ]);
  });

  test("a bulk add appends every key with continuing ranks", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const provider = await createProvider(deps, "user-1", {
      name: "Bulk",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "first-key",
    });

    const added = await addProviderCredentials(deps, "user-1", provider.id, [
      "one",
      "two",
      "three",
    ]);

    if (added.kind !== "ok") throw new Error("the bulk add failed: " + added.kind);

    expect(added.provider.credentials.map((credential) => credential.priority)).toEqual([
      1, 2, 3, 4,
    ]);

    const stored = handle.db
      .select({
        credential: providerCredentials.credential,
        priority: providerCredentials.priority,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, provider.id))
      .orderBy(asc(providerCredentials.priority))
      .all();

    const opened = await Promise.all(stored.map((row) => readCredential(deps, row.credential)));

    expect(opened).toEqual([
      { authMode: "api-key", apiKey: "first-key" },
      { authMode: "api-key", apiKey: "one" },
      { authMode: "api-key", apiKey: "two" },
      { authMode: "api-key", apiKey: "three" },
    ]);
  });

  test("a bulk add to an unknown provider or account is missing_provider", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    handle.db.insert(user).values({ id: "user-2", name: "Other", email: "user-2@test" }).run();

    const provider = await createProvider(deps, "user-1", {
      name: "Absent",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    expect((await addProviderCredentials(deps, "user-1", "absent", ["one"])).kind).toBe(
      "missing_provider",
    );
    expect((await addProviderCredentials(deps, "user-2", provider.id, ["one"])).kind).toBe(
      "missing_provider",
    );
  });

  test("a provider value reports the auth modes its kind accepts", async () => {
    const handle = freshDb();
    const deps = await providerDeps(handle);

    const list = await listProviders(deps, "user-1");
    const builtIn = list.providers.find((provider) => provider.kind === "kilocode");

    const custom = await createProvider(deps, "user-1", {
      name: "Modes",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "",
    });

    expect(builtIn?.authModes).toEqual(["api-key", "oauth"]);
    expect(custom.authModes).toEqual(["api-key"]);
  });

  test("migration 0008 moves a stored key into the first credential", () => {
    const handle = openDatabase(":memory:");
    open.push(handle);

    const all = migrations();

    applyMigrations(
      handle.sqlite,
      all.filter((migration) => migration.tag < "0008"),
    );

    handle.db.insert(user).values({ id: "user-1", name: "User", email: "user-1@test" }).run();
    handle.sqlite.exec(
      `INSERT INTO providers (id, user_id, name, slug, kind, base_url, api_key, auth_mode, origin, created_at)
       VALUES ('provider-keyed', 'user-1', 'Keyed', 'keyed', 'openai', 'https://example.com', 'SEALED', 'api-key', 'custom', 1),
              ('provider-empty', 'user-1', 'Empty', 'empty', 'openai', 'https://example.com', '', 'api-key', 'custom', 2)`,
    );
    handle.sqlite.exec(
      `INSERT INTO provider_models (id, user_id, provider_id, alias, upstream_model, enabled, created_at)
       VALUES ('model-keyed', 'user-1', 'provider-keyed', 'fast', 'gpt', 1, 3)`,
    );

    expect(applyMigrations(handle.sqlite, all).applied).toEqual([
      "0008_provider_credentials",
      "0009_remarkable_ronan",
      "0010_cooldown_error_message",
      "0011_petite_leopardon",
      "0012_tiresome_amphibian",
    ]);

    const rows = handle.sqlite
      .query<{ provider_id: string; credential: string; auth_mode: string; priority: number }, []>(
        "SELECT provider_id, credential, auth_mode, priority FROM provider_credentials",
      )
      .all();

    expect(rows).toEqual([
      { provider_id: "provider-keyed", credential: "SEALED", auth_mode: "api-key", priority: 1 },
    ]);

    const columns = handle.sqlite
      .query<{ name: string }, []>("PRAGMA table_info(providers)")
      .all()
      .map((column) => column.name);

    expect(columns).not.toContain("api_key");
    expect(columns).not.toContain("auth_mode");

    expect(
      handle.sqlite
        .query<{ id: string; provider_id: string }, []>(
          "SELECT id, provider_id FROM provider_models",
        )
        .all(),
    ).toEqual([{ id: "model-keyed", provider_id: "provider-keyed" }]);
  });
});

async function addCredential(
  deps: ProviderDeps,
  providerId: string,
  apiKey: string,
  label?: string,
): Promise<Provider> {
  const result = await addProviderCredential(deps, "user-1", providerId, { apiKey, label });

  if (result.kind !== "ok") throw new Error(`adding a credential failed: ${result.kind}`);

  return result.provider;
}

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
