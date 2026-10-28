import { and, asc, eq } from "drizzle-orm";
import {
  BUILT_IN_PROVIDER_KINDS,
  parseCompat,
  type Compat,
  type Provider,
  type ProviderCredential,
  type ProviderCreateInput,
  type ProviderInput,
  type ProviderKind,
  type ProviderList,
  type ProviderModelEditInput,
  type ProviderModelInput,
} from "../../shared/providers";
import { availableSlug, providerRefOf, slugify, TAG_REF_PREFIX } from "../../shared/slugs";
import { parseCredential, type Credential } from "../credential";
import type { Db } from "../db/client";
import { providerCredentials, providerModels, providers } from "../db/schema";
import type { Sealer } from "../seal";
import { renumberTagPriorities } from "../tags";
import { compatsOf, definitionFor, reservedProviderSlugs } from "./registry";
import { ensureBuiltInProviders } from "./seeding";
import type { ModelCatalogEntry } from "./types";

export { definitionFor };

export type ProviderDeps = { readonly db: Db; readonly sealer: Sealer };

const BUILT_IN_RANK = new Map<string, number>(
  BUILT_IN_PROVIDER_KINDS.map((kind, index) => [kind, index] as const),
);

export class ProviderRuleError extends Error {
  readonly code: "built_in" | "validation" | "conflict";

  constructor(message: string, code: "built_in" | "validation" | "conflict" = "built_in") {
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
};

export async function listProviders(deps: ProviderDeps, userId: string): Promise<ProviderList> {
  await ensureBuiltInProviders(deps.db, userId);

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

  const credentialRows = await deps.db
    .select({
      id: providerCredentials.id,
      providerId: providerCredentials.providerId,
      label: providerCredentials.label,
      authMode: providerCredentials.authMode,
      priority: providerCredentials.priority,
      failures: providerCredentials.failures,
      flaggedUntil: providerCredentials.flaggedUntil,
      createdAt: providerCredentials.createdAt,
    })
    .from(providerCredentials)
    .innerJoin(providers, eq(providers.id, providerCredentials.providerId))
    .where(eq(providers.userId, userId))
    .orderBy(asc(providerCredentials.providerId), asc(providerCredentials.priority));

  const credentials = new Map<string, ProviderCredential[]>();

  for (const row of credentialRows) {
    const list = credentials.get(row.providerId) ?? [];

    list.push({
      id: row.id,
      label: row.label,
      authMode: row.authMode,
      priority: row.priority,
      failures: row.failures,
      flaggedUntil: row.flaggedUntil?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
    credentials.set(row.providerId, list);
  }

  const enabledAliases = new Set(modelRows.filter((row) => row.enabled).map((row) => row.alias));
  const providerSlugs = new Map(providerRows.map((row) => [row.id, row.slug]));
  const providerKinds = new Map(providerRows.map((row) => [row.id, row.kind]));

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
      compat: parseCompat(row.compat),
      defaultCompat: defaultCompatOf(providerKinds.get(row.providerId), row.upstreamModel),
      inputPricePerMtok: row.inputPricePerMtok,
      outputPricePerMtok: row.outputPricePerMtok,
      failures: row.failures,
      flaggedUntil: row.flaggedUntil?.toISOString() ?? null,
    });
    grouped.set(row.providerId, list);
  }

  const ordered = [...providerRows].sort((left, right) => {
    const leftRank = left.origin === "builtin" ? 0 : 1;
    const rightRank = right.origin === "builtin" ? 0 : 1;

    if (leftRank !== rightRank) return leftRank - rightRank;

    if (left.origin === "builtin" && right.origin === "builtin") {
      const leftOrder = BUILT_IN_RANK.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = BUILT_IN_RANK.get(right.kind) ?? Number.MAX_SAFE_INTEGER;

      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }

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
      authModes: [...definitionFor(row.kind).authModes],
      compats: compatsOf(row.kind),
      hasCatalog: definitionFor(row.kind).catalog !== undefined,
      credentials: credentials.get(row.id) ?? [],
      models: grouped.get(row.id) ?? [],
      failures: row.failures,
      flaggedUntil: row.flaggedUntil?.toISOString() ?? null,
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
  await ensureBuiltInProviders(deps.db, userId);

  const id = crypto.randomUUID();
  const now = new Date();
  const slug = availableSlug(slugify(input.name), await takenSlugs(deps, userId));

  const sealed = input.apiKey === "" ? null : await sealApiKey(deps, input.apiKey);

  deps.db.transaction((tx) => {
    tx.insert(providers)
      .values({
        id,
        userId,
        name: input.name,
        slug,
        kind: input.kind,
        baseUrl: input.baseUrl,
        origin: "custom",
        createdAt: now,
      })
      .run();

    if (sealed === null) return;

    tx.insert(providerCredentials)
      .values({
        id: crypto.randomUUID(),
        providerId: id,
        label: "",
        credential: sealed,
        authMode: "api-key",
        priority: 1,
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

  if (existing.origin === "custom" && definitionFor(input.kind).builtIn !== undefined) {
    throw new ProviderRuleError("custom providers use one of the generic wires", "validation");
  }

  const patch: ProviderPatch = {
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
  };

  if (input.slug !== undefined && input.slug !== existing.slug) {
    if (reservedProviderSlugs.has(input.slug)) {
      throw new ProviderRuleError(`${input.slug} is a reserved slug`, "validation");
    }

    patch.slug = input.slug;
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

  const duplicate = await deps.db
    .select({ id: providerModels.id })
    .from(providerModels)
    .where(
      and(
        eq(providerModels.providerId, providerId),
        eq(providerModels.upstreamModel, model.upstreamModel),
      ),
    )
    .limit(1);

  if (duplicate[0] !== undefined) {
    throw new ProviderRuleError(
      `${model.upstreamModel} is already a model on this provider`,
      "conflict",
    );
  }

  deps.db
    .insert(providerModels)
    .values(modelRow(userId, providerId, model, new Date(), 0))
    .run();

  return findProvider(deps, userId, providerId);
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

  await renumberTagPriorities(deps, userId);

  return findProvider(deps, userId, providerId);
}

export async function updateProviderModel(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  modelId: string,
  edit: ProviderModelEditInput,
): Promise<Provider | null> {
  const provider = await findProvider(deps, userId, providerId);

  if (provider === null) return null;

  if (edit.compat !== null && !provider.compats.includes(edit.compat)) {
    throw new ProviderRuleError(
      `${provider.kind} does not speak the ${edit.compat} wire`,
      "validation",
    );
  }

  if (edit.alias.startsWith(TAG_REF_PREFIX)) {
    throw new ProviderRuleError(`an alias cannot start with ${TAG_REF_PREFIX}`, "validation");
  }

  const clash = await deps.db
    .select({ id: providerModels.id })
    .from(providerModels)
    .where(and(eq(providerModels.userId, userId), eq(providerModels.alias, edit.alias)))
    .limit(1);

  if (clash[0] !== undefined && clash[0].id !== modelId) {
    throw new ProviderRuleError(`the alias ${edit.alias} is taken`, "conflict");
  }

  const updated = await deps.db
    .update(providerModels)
    .set({
      alias: edit.alias,
      compat: edit.compat,
      inputPricePerMtok: edit.inputPricePerMtok,
      outputPricePerMtok: edit.outputPricePerMtok,
    })
    .where(and(eq(providerModels.id, modelId), eq(providerModels.providerId, providerId)))
    .returning({ id: providerModels.id });

  if (updated.length === 0) return null;

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

  if (removed.length > 0) await renumberTagPriorities(deps, userId);

  return removed.length > 0;
}

function defaultCompatOf(kind: ProviderKind | undefined, upstreamModel: string): Compat | null {
  if (kind === undefined) return null;

  return definitionFor(kind).defaultCompat(upstreamModel).compat;
}

export function sealApiKey(deps: ProviderDeps, apiKey: string): Promise<string> {
  return deps.sealer.seal(JSON.stringify({ authMode: "api-key", apiKey } satisfies Credential));
}

/** The credential the chain tries first, or null when the provider has none. */
export async function readFirstCredential(
  deps: ProviderDeps,
  providerId: string,
): Promise<Credential | null> {
  const row = await deps.db
    .select({ credential: providerCredentials.credential })
    .from(providerCredentials)
    .where(eq(providerCredentials.providerId, providerId))
    .orderBy(asc(providerCredentials.priority))
    .limit(1);

  const sealed = row[0]?.credential;

  return sealed === undefined ? null : readCredential(deps, sealed);
}

export async function readCredential(deps: ProviderDeps, sealed: string): Promise<Credential> {
  if (sealed === "") return { authMode: "api-key", apiKey: "" };

  const plaintext = await deps.sealer.open(sealed);

  const credential = parseCredential(plaintext);

  // A key saved before credentials carried an auth mode is a bare key.
  return credential ?? { authMode: "api-key", apiKey: plaintext };
}

async function takenSlugs(deps: ProviderDeps, userId: string): Promise<Set<string>> {
  const rows = await deps.db
    .select({ slug: providers.slug })
    .from(providers)
    .where(eq(providers.userId, userId));

  const taken = new Set(reservedProviderSlugs);

  for (const row of rows) {
    if (row.slug !== "") taken.add(row.slug);
  }

  return taken;
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
    compat: null,
    inputPricePerMtok: model.inputPricePerMtok ?? null,
    outputPricePerMtok: model.outputPricePerMtok ?? null,
    enabled: true,
    createdAt: new Date(now.getTime() + index),
  };
}
