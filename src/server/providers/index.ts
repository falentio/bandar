import { and, asc, eq } from "drizzle-orm";
import type {
  Provider,
  ProviderAuthMode,
  ProviderCredential,
  ProviderCreateInput,
  ProviderInput,
  ProviderKind,
  ProviderList,
  ProviderModelInput,
} from "../../shared/providers";
import { availableSlug, providerRefOf, slugify, TAG_REF_PREFIX } from "../../shared/slugs";
import { parseCredential, type Credential } from "../credential";
import type { Db } from "../db/client";
import { providerCredentials, providerModels, providers } from "../db/schema";
import type { Sealer } from "../seal";
import { renumberTagPriorities } from "../tags";
import { builtInProviders, definitionFor, reservedProviderSlugs } from "./registry";
import type { ModelCatalogEntry } from "./types";

export { definitionFor };

export type ProviderDeps = { readonly db: Db; readonly sealer: Sealer };

export class ProviderRuleError extends Error {
  readonly code: "built_in" | "validation" | "conflict";

  constructor(message: string, code: "built_in" | "validation" | "conflict" = "built_in") {
    super(message);
    this.name = "ProviderRuleError";
    this.code = code;
  }
}

export function authModesFor(kind: ProviderKind): ProviderAuthMode[] {
  return definitionFor(kind).oauth === undefined ? ["api-key"] : ["api-key", "oauth"];
}

type ProviderPatch = {
  name: string;
  slug?: string;
  kind: ProviderKind;
  baseUrl: string;
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

  const credentialRows = await deps.db
    .select({
      id: providerCredentials.id,
      providerId: providerCredentials.providerId,
      label: providerCredentials.label,
      authMode: providerCredentials.authMode,
      priority: providerCredentials.priority,
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
      createdAt: row.createdAt.toISOString(),
    });
    credentials.set(row.providerId, list);
  }

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
      authModes: authModesFor(row.kind),
      credentials: credentials.get(row.id) ?? [],
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

export function sealApiKey(deps: ProviderDeps, apiKey: string): Promise<string> {
  return deps.sealer.seal(JSON.stringify({ authMode: "api-key", apiKey } satisfies Credential));
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

  for (const definition of builtInProviders) {
    if (present.has(definition.kind)) continue;

    const name = availableName(definition.builtIn.name, names);
    const slug = definition.builtIn.slug;

    names.add(name);

    deps.db
      .insert(providers)
      .values({
        id: crypto.randomUUID(),
        userId,
        name,
        slug,
        kind: definition.kind,
        baseUrl: definition.builtIn.baseUrl(),
        origin: "builtin",
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
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

  const taken = new Set(reservedProviderSlugs);

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
    const taken = new Set(reservedProviderSlugs);

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
  return definitionFor(kind).builtIn?.slug ?? null;
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
