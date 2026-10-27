import { and, asc, eq } from "drizzle-orm";
import * as v from "valibot";
import {
  BUILT_IN_PROVIDERS,
  BUILT_IN_PROVIDER_KINDS,
  GENERIC_PROVIDER_KINDS,
  RESERVED_PROVIDER_SLUGS,
  type Provider,
  type ProviderAuthMode,
  type ProviderCreateInput,
  type ProviderInput,
  type ProviderKind,
  type ProviderList,
  type ProviderModelInput,
} from "../shared/providers";
import { availableSlug, providerRefOf, slugify, TAG_REF_PREFIX } from "../shared/slugs";
import { parseCredential, type Credential } from "./credential";
import { KILO_MODELS_URL } from "./router/adapters/kilocode";
import type { Db } from "./db/client";
import { UpstreamError } from "./router/types";
import { providerModels, providers } from "./db/schema";
import type { Sealer } from "./seal";

export type ProviderDeps = { readonly db: Db; readonly sealer: Sealer };

export class ProviderRuleError extends Error {
  readonly code: "built_in" | "validation";

  constructor(message: string, code: "built_in" | "validation" = "built_in") {
    super(message);
    this.name = "ProviderRuleError";
    this.code = code;
  }
}

type ProviderPatch = {
  name: string;
  slug?: string;
  kind: ProviderKind;
  baseUrl: string;
  authMode?: ProviderAuthMode;
  apiKey?: string;
};

export async function listProviders(deps: ProviderDeps, userId: string): Promise<ProviderList> {
  await ensureBuiltInProviders(deps, userId);

  const providerRows = await deps.db
    .select()
    .from(providers)
    .where(eq(providers.userId, userId))
    .orderBy(asc(providers.createdAt));

  const modelRows = await deps.db
    .select()
    .from(providerModels)
    .where(eq(providerModels.userId, userId))
    .orderBy(asc(providerModels.createdAt));

  const enabledAliases = new Set(modelRows.filter((row) => row.enabled).map((row) => row.alias));
  const providerSlugs = new Map(providerRows.map((row) => [row.id, row.slug]));

  const grouped = new Map<string, Provider["models"][number][]>();

  for (const row of modelRows) {
    const list = grouped.get(row.providerId) ?? [];
    const ref = providerRefOf(providerSlugs.get(row.providerId) ?? "", row.upstreamModel);

    list.push({
      id: row.id,
      upstreamModel: row.upstreamModel,
      alias: row.alias,
      ref,
      shadowed: enabledAliases.has(ref),
      inputPricePerMtok: row.inputPricePerMtok,
      outputPricePerMtok: row.outputPricePerMtok,
    });
    grouped.set(row.providerId, list);
  }

  const ordered = [...providerRows].sort((left, right) => {
    const leftRank = left.origin === "builtin" ? 0 : 1;
    const rightRank = right.origin === "builtin" ? 0 : 1;

    if (leftRank !== rightRank) return leftRank - rightRank;

    return left.createdAt.getTime() - right.createdAt.getTime();
  });

  return {
    providers: ordered.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: row.kind,
      origin: row.origin,
      baseUrl: row.baseUrl,
      authMode: row.authMode,
      hasKey: row.apiKey !== "",
      models: grouped.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function readProvider(
  deps: ProviderDeps,
  userId: string,
  id: string,
): Promise<Provider | null> {
  return findProvider(deps, userId, id);
}

export async function createProvider(
  deps: ProviderDeps,
  userId: string,
  input: ProviderCreateInput,
): Promise<Provider> {
  await ensureBuiltInProviders(deps, userId);

  const id = crypto.randomUUID();
  const now = new Date();
  const slug = availableSlug(slugify(input.name), await takenSlugs(deps, userId));

  const apiKey =
    input.apiKey === ""
      ? ""
      : await deps.sealer.seal(
          JSON.stringify({ authMode: "api-key", apiKey: input.apiKey } satisfies Credential),
        );

  deps.db.transaction((tx) => {
    tx.insert(providers)
      .values({
        id,
        userId,
        name: input.name,
        slug,
        kind: input.kind,
        baseUrl: input.baseUrl,
        apiKey,
        authMode: "api-key",
        origin: "custom",
        createdAt: now,
      })
      .run();
  });

  const created = await findProvider(deps, userId, id);

  if (created === null) throw new Error(`provider ${id} vanished after insert`);

  return created;
}

export async function updateProvider(
  deps: ProviderDeps,
  userId: string,
  id: string,
  input: ProviderInput,
): Promise<Provider | null> {
  const existing = await findProvider(deps, userId, id);

  if (existing === null) return null;

  if (
    existing.origin === "builtin" &&
    (input.name !== existing.name ||
      input.kind !== existing.kind ||
      input.baseUrl !== existing.baseUrl ||
      (input.slug !== undefined && input.slug !== existing.slug))
  ) {
    throw new ProviderRuleError("built-in provider settings come from the code");
  }

  if (existing.origin === "custom" && !GENERIC_PROVIDER_KINDS.some((kind) => kind === input.kind)) {
    throw new ProviderRuleError("custom providers use one of the generic wires");
  }

  const apiKey =
    input.apiKey === ""
      ? undefined
      : await deps.sealer.seal(
          JSON.stringify({ authMode: "api-key", apiKey: input.apiKey } satisfies Credential),
        );

  const patch: ProviderPatch = {
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
  };

  if (input.slug !== undefined) {
    if (RESERVED_PROVIDER_SLUGS.has(input.slug)) {
      throw new ProviderRuleError(`${input.slug} is a reserved slug`, "validation");
    }

    patch.slug = input.slug;
  }

  if (apiKey !== undefined) {
    patch.apiKey = apiKey;
    patch.authMode = "api-key";
  }

  deps.db.transaction((tx) => {
    tx.update(providers)
      .set(patch)
      .where(and(eq(providers.id, id), eq(providers.userId, userId)))
      .run();
  });

  return findProvider(deps, userId, id);
}

export async function addProviderModel(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  model: ProviderModelInput,
): Promise<Provider | null> {
  if ((await findProvider(deps, userId, providerId)) === null) return null;

  deps.db
    .insert(providerModels)
    .values(modelRow(userId, providerId, model, new Date(), 0))
    .run();

  return findProvider(deps, userId, providerId);
}

export type ModelCatalogEntry = {
  readonly upstreamModel: string;
  readonly alias: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
};

const PriceSchema = v.union([v.string(), v.number()]);

const KiloCatalogSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      pricing: v.optional(
        v.nullable(
          v.object({
            prompt: v.optional(PriceSchema),
            completion: v.optional(PriceSchema),
          }),
        ),
      ),
    }),
  ),
});

export async function fetchKilocodeCatalog(
  signal: AbortSignal,
): Promise<readonly ModelCatalogEntry[]> {
  const url = Bun.env.BANDAR_KILOCODE_MODELS_URL ?? KILO_MODELS_URL;

  const response = await fetch(url, { signal }).catch((error: Error) => {
    throw new UpstreamError(`could not read the kilo code catalog: ${error.message}`, "network");
  });

  if (!response.ok) {
    throw new UpstreamError(
      `could not read the kilo code catalog (${response.status})`,
      "unavailable",
      response.status,
    );
  }

  const parsed = v.safeParse(KiloCatalogSchema, await response.json());

  if (!parsed.success) throw new UpstreamError("kilo code catalog is not readable", "protocol");

  const aliases = new Set<string>();
  const ids = new Set<string>();

  return parsed.output.data.flatMap((model) => {
    if (ids.has(model.id)) return [];

    ids.add(model.id);

    const base = aliasFor(model.id);
    const alias = aliases.has(base) ? model.id : base;

    aliases.add(alias);

    return [
      {
        upstreamModel: model.id,
        alias,
        inputPricePerMtok: pricePerMtok(model.pricing?.prompt),
        outputPricePerMtok: pricePerMtok(model.pricing?.completion),
      },
    ];
  });
}

export async function syncProviderModels(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  models: readonly ModelCatalogEntry[],
): Promise<Provider | null> {
  if ((await findProvider(deps, userId, providerId)) === null) return null;

  const existing = await deps.db
    .select()
    .from(providerModels)
    .where(eq(providerModels.providerId, providerId));

  const takenUpstream = new Set(existing.map((row) => row.upstreamModel));

  const takenAlias = new Set(
    deps.db
      .select({ alias: providerModels.alias })
      .from(providerModels)
      .where(eq(providerModels.userId, userId))
      .all()
      .map((row) => row.alias),
  );

  const now = new Date();

  const missing = models.flatMap((model, index) => {
    if (model.alias.startsWith(TAG_REF_PREFIX)) return [];

    if (takenUpstream.has(model.upstreamModel) || takenAlias.has(model.alias)) return [];

    takenAlias.add(model.alias);

    return [
      {
        id: crypto.randomUUID(),
        userId,
        providerId,
        alias: model.alias,
        upstreamModel: model.upstreamModel,
        inputPricePerMtok: model.inputPricePerMtok,
        outputPricePerMtok: model.outputPricePerMtok,
        enabled: true,
        createdAt: new Date(now.getTime() + index),
      },
    ];
  });

  if (missing.length > 0) deps.db.insert(providerModels).values(missing).run();

  return findProvider(deps, userId, providerId);
}

export async function removeProviderModel(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  modelId: string,
): Promise<Provider | null> {
  if ((await findProvider(deps, userId, providerId)) === null) return null;

  deps.db
    .delete(providerModels)
    .where(and(eq(providerModels.id, modelId), eq(providerModels.providerId, providerId)))
    .run();

  return findProvider(deps, userId, providerId);
}

export async function removeProvider(
  deps: ProviderDeps,
  userId: string,
  id: string,
): Promise<boolean> {
  const removed = await deps.db
    .delete(providers)
    .where(and(eq(providers.id, id), eq(providers.userId, userId)))
    .returning({ id: providers.id });

  return removed.length > 0;
}

export async function readCredential(deps: ProviderDeps, sealed: string): Promise<Credential> {
  if (sealed === "") return { authMode: "api-key", apiKey: "" };

  const plaintext = await deps.sealer.open(sealed);

  const credential = parseCredential(plaintext);

  // A key saved before credentials carried an auth mode is a bare key.
  return credential ?? { authMode: "api-key", apiKey: plaintext };
}

async function ensureBuiltInProviders(deps: ProviderDeps, userId: string): Promise<void> {
  const rows = await deps.db
    .select({
      kind: providers.kind,
      name: providers.name,
      origin: providers.origin,
      slug: providers.slug,
    })
    .from(providers)
    .where(eq(providers.userId, userId));

  const present = new Set(rows.filter((row) => row.origin === "builtin").map((row) => row.kind));
  const names = new Set(rows.map((row) => row.name));
  const now = new Date();

  for (const kind of BUILT_IN_PROVIDER_KINDS) {
    if (present.has(kind)) continue;

    const definition = BUILT_IN_PROVIDERS[kind];
    const name = availableName(definition.name, names);
    const slug = definition.slug;

    names.add(name);

    deps.db
      .insert(providers)
      .values({
        id: crypto.randomUUID(),
        userId,
        name,
        slug,
        kind,
        baseUrl: builtInBaseUrl(kind),
        apiKey: "",
        authMode: "api-key",
        origin: "builtin",
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
}

function builtInBaseUrl(kind: keyof typeof BUILT_IN_PROVIDERS): string {
  const definition = BUILT_IN_PROVIDERS[kind];

  if (kind !== "kilocode") return definition.baseUrl;

  const origin =
    Bun.env.BANDAR_KILOCODE_API?.replace(/\/+$/, "") ?? new URL(definition.baseUrl).origin;

  return `${origin}/api/openrouter`;
}

function availableName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  let suffix = 2;

  while (taken.has(`${base} ${suffix}`)) suffix += 1;

  return `${base} ${suffix}`;
}

async function takenSlugs(deps: ProviderDeps, userId: string): Promise<Set<string>> {
  const rows = await deps.db
    .select({ slug: providers.slug })
    .from(providers)
    .where(eq(providers.userId, userId));

  const taken = new Set(RESERVED_PROVIDER_SLUGS);

  for (const row of rows) {
    if (row.slug !== "") taken.add(row.slug);
  }

  return taken;
}

export async function assignProviderSlugs(db: Db): Promise<number> {
  const rows = await db
    .select({
      id: providers.id,
      userId: providers.userId,
      name: providers.name,
      kind: providers.kind,
      origin: providers.origin,
      slug: providers.slug,
      createdAt: providers.createdAt,
    })
    .from(providers);

  const byUser = new Map<string, typeof rows>();

  for (const row of rows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
  }

  let assigned = 0;

  for (const userRows of byUser.values()) {
    const taken = new Set(RESERVED_PROVIDER_SLUGS);

    for (const row of userRows) {
      if (row.slug !== "") taken.add(row.slug);
    }

    const pending = userRows
      .filter((row) => row.slug === "")
      .sort((left, right) => {
        const leftRank = left.origin === "builtin" ? 0 : 1;
        const rightRank = right.origin === "builtin" ? 0 : 1;

        if (leftRank !== rightRank) return leftRank - rightRank;

        const created = left.createdAt.getTime() - right.createdAt.getTime();

        return created !== 0 ? created : left.id.localeCompare(right.id);
      });

    if (pending.length === 0) continue;

    db.transaction((tx) => {
      for (const row of pending) {
        const builtIn = builtInSlugOf(row.kind);
        const slug = builtIn ?? availableSlug(slugify(row.name), taken);

        tx.update(providers).set({ slug }).where(eq(providers.id, row.id)).run();
        taken.add(slug);
        assigned += 1;
      }
    });
  }

  return assigned;
}

function builtInSlugOf(kind: ProviderKind): string | null {
  const builtIn = BUILT_IN_PROVIDER_KINDS.find((candidate) => candidate === kind);

  return builtIn === undefined ? null : BUILT_IN_PROVIDERS[builtIn].slug;
}

export async function saveOAuthCredential(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  credential: Credential,
): Promise<Provider | null> {
  if ((await findProvider(deps, userId, providerId)) === null) return null;

  deps.db
    .update(providers)
    .set({
      apiKey: await deps.sealer.seal(JSON.stringify(credential)),
      authMode: credential.authMode,
    })
    .where(and(eq(providers.id, providerId), eq(providers.userId, userId)))
    .run();

  return findProvider(deps, userId, providerId);
}

/** Model ids are namespaced, so the alias keeps the namespace and loses only the `:free` tag. */
function aliasFor(upstreamModel: string): string {
  return upstreamModel.replace(/:free$/, "");
}

function pricePerMtok(value: string | number | undefined): number | null {
  if (value === undefined) return null;

  const perToken = Number(value);

  // Kilo reports `-1` for a model it routes dynamically, and 0 for a free one.
  if (!Number.isFinite(perToken) || perToken < 0) return null;

  return perToken * 1_000_000;
}

async function findProvider(
  deps: ProviderDeps,
  userId: string,
  id: string,
): Promise<Provider | null> {
  const list = await listProviders(deps, userId);

  return list.providers.find((provider) => provider.id === id) ?? null;
}

function modelRow(
  userId: string,
  providerId: string,
  model: ProviderModelInput,
  now: Date,
  index: number,
) {
  return {
    id: crypto.randomUUID(),
    userId,
    providerId,
    alias: model.alias ?? model.upstreamModel,
    upstreamModel: model.upstreamModel,
    inputPricePerMtok: model.inputPricePerMtok ?? null,
    outputPricePerMtok: model.outputPricePerMtok ?? null,
    enabled: true,
    createdAt: new Date(now.getTime() + index),
  };
}
