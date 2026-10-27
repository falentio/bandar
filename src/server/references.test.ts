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
import { listProviders, updateProvider, type ProviderDeps } from "./providers";
import { createSealer } from "./seal";

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
