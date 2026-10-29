import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { readCooldowns } from "./cooldowns";
import { addProviderCredential } from "./credentials";
import { user } from "./db/auth-schema";
import { openDatabase, type DatabaseHandle } from "./db/client";
import { applyMigrations, type Migration } from "./db/migrate";
import { cooldownEvents, providerCredentials } from "./db/schema";
import {
  COOLDOWN_HISTORY_LIMIT,
  recordFailure,
  type FailureContext,
  type FailureRecord,
} from "./health";
import { addProviderModel, createProvider, type ProviderDeps } from "./providers";
import { DEFAULT_PROVIDER_ENDPOINTS } from "./providers/endpoints";
import { createSealer } from "./seal";

const SQLITE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

let open: DatabaseHandle[] = [];

afterEach(() => {
  for (const handle of open) handle.sqlite.close();
  open = [];
});

type Seeded = {
  readonly userId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelSlug: string;
  readonly credentialId: string;
  readonly credentialName: string;
};

describe("cooldown history", () => {
  test("records one row per failure and doubles the cooldown", async () => {
    const handle = freshDb();
    const seeded = await seedCredential(handle, "user-1");
    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = new Date("2026-01-01T00:01:00.000Z");

    recordFailure(handle.db, failureOf(seeded, first));
    recordFailure(handle.db, failureOf(seeded, second));

    const list = await readCooldowns(handle.db, "user-1", 100);

    expect(list.events).toHaveLength(2);
    expect(list.events[0]?.createdAt).toBe(second.toISOString());
    expect(list.events[0]?.cooldownMs).toBe(60_000);
    expect(list.events[0]?.failures).toBe(2);
    expect(list.events[1]?.cooldownMs).toBe(30_000);
    expect(list.events[1]?.failures).toBe(1);
    expect(list.events[0]).toMatchObject({
      subject: "credential",
      subjectName: "primary",
      providerId: seeded.providerId,
      providerName: "Primary",
      modelId: seeded.modelId,
      modelSlug: "fast",
      credentialId: seeded.credentialId,
      credentialName: "primary",
      errorKind: "auth",
      reference: "fast",
    });
    expect(list.events[0]?.flaggedUntil).toBe(new Date(second.getTime() + 60_000).toISOString());
  });

  test("readCooldowns scopes history to one user", async () => {
    const handle = freshDb();

    handle.db.insert(user).values({ id: "user-2", name: "Other", email: "user-2@test" }).run();

    const mine = await seedCredential(handle, "user-1");
    const other = await seedCredential(handle, "user-2");
    const now = new Date("2026-01-01T00:00:00.000Z");

    recordFailure(handle.db, failureOf(mine, now));
    recordFailure(handle.db, failureOf(other, new Date(now.getTime() + 1000)));

    const mineList = await readCooldowns(handle.db, "user-1", 100);
    const otherList = await readCooldowns(handle.db, "user-2", 100);

    expect(mineList.events).toHaveLength(1);
    expect(mineList.events[0]?.providerId).toBe(mine.providerId);
    expect(otherList.events).toHaveLength(1);
    expect(otherList.events[0]?.providerId).toBe(other.providerId);
  });

  test("drops a user's history when the user is deleted", async () => {
    const handle = freshDb();
    const seeded = await seedCredential(handle, "user-1");

    recordFailure(handle.db, failureOf(seeded, new Date("2026-01-01T00:00:00.000Z")));
    handle.db.delete(user).where(eq(user.id, "user-1")).run();

    expect(handle.db.select().from(cooldownEvents).all()).toHaveLength(0);
  });

  test("keeps at most 500 rows per user", async () => {
    const handle = freshDb();
    const seeded = await seedCredential(handle, "user-1");
    const start = Date.parse("2026-01-01T00:00:00.000Z");

    for (let index = 0; index < 505; index += 1) {
      recordFailure(handle.db, failureOf(seeded, new Date(start + index * 1000)));
    }

    const list = await readCooldowns(handle.db, "user-1", 600);

    expect(list.events).toHaveLength(COOLDOWN_HISTORY_LIMIT);
    expect(list.events[0]?.createdAt).toBe(new Date(start + 504_000).toISOString());
    expect(list.events.at(-1)?.createdAt).toBe(new Date(start + 5000).toISOString());
  });
});

function failureOf(seeded: Seeded, now: Date): FailureRecord {
  const context: FailureContext = {
    userId: seeded.userId,
    reference: "fast",
    errorKind: "auth",
    providerId: seeded.providerId,
    providerName: seeded.providerName,
    modelId: seeded.modelId,
    modelSlug: seeded.modelSlug,
    credentialId: seeded.credentialId,
    credentialName: seeded.credentialName,
  };

  return { subject: { kind: "credential", id: seeded.credentialId }, context, now };
}

async function seedCredential(handle: DatabaseHandle, userId: string): Promise<Seeded> {
  const deps = await providerDeps(handle);

  const provider = await createProvider(deps, userId, {
    name: "Primary",
    kind: "openai",
    baseUrl: "https://example.com",
    apiKey: "",
  });

  const withModel = await addProviderModel(deps, userId, provider.id, {
    upstreamModel: "m",
    slug: "fast",
  });

  const model = withModel?.models.find((entry) => entry.slug === "fast");

  const added = await addProviderCredential(deps, userId, provider.id, {
    label: "primary",
    apiKey: "key",
  });

  if (added.kind !== "ok") throw new Error(`adding a credential failed: ${added.kind}`);

  const credential = handle.db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.providerId, provider.id))
    .get();

  if (model === undefined || credential === undefined) throw new Error("the seed is incomplete");

  return {
    userId,
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelSlug: model.slug,
    credentialId: credential.id,
    credentialName: credential.label,
  };
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
  return createSealer("test-secret").then((sealer) => ({
    db: handle.db,
    sealer,
    endpoints: DEFAULT_PROVIDER_ENDPOINTS,
  }));
}
