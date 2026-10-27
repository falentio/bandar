import { and, asc, eq } from "drizzle-orm";
import type { Provider, ProviderInput, ProviderKind, ProviderList } from "../shared/providers";
import type { Db } from "./db/client";
import { providerModels, providers } from "./db/schema";
import type { Sealer } from "./seal";

export type ProviderDeps = { readonly db: Db; readonly sealer: Sealer };

type ProviderPatch = {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
};

export type ResolvedTarget = {
  readonly modelId: string;
  readonly alias: string;
  readonly upstreamModel: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly providerId: string;
  readonly providerName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
};

export async function listProviders(deps: ProviderDeps, userId: string): Promise<ProviderList> {
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

  const grouped = new Map<string, Provider["models"][number][]>();

  for (const row of modelRows) {
    const list = grouped.get(row.providerId) ?? [];
    list.push({
      id: row.id,
      upstreamModel: row.upstreamModel,
      alias: row.alias,
      inputPricePerMtok: row.inputPricePerMtok,
      outputPricePerMtok: row.outputPricePerMtok,
    });
    grouped.set(row.providerId, list);
  }

  return {
    providers: providerRows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUrl: row.baseUrl,
      hasKey: row.apiKey !== "",
      models: grouped.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function createProvider(
  deps: ProviderDeps,
  userId: string,
  input: ProviderInput,
): Promise<Provider> {
  const id = crypto.randomUUID();
  const now = new Date();
  const apiKey = input.apiKey === "" ? "" : await deps.sealer.seal(input.apiKey);

  deps.db.transaction((tx) => {
    tx.insert(providers)
      .values({
        id,
        userId,
        name: input.name,
        kind: input.kind,
        baseUrl: input.baseUrl,
        apiKey,
        createdAt: now,
      })
      .run();

    tx.insert(providerModels)
      .values(input.models.map((model, index) => modelRow(userId, id, model, now, index)))
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

  const apiKey = input.apiKey === "" ? undefined : await deps.sealer.seal(input.apiKey);

  const now = new Date();

  const patch: ProviderPatch = {
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
  };

  if (apiKey !== undefined) patch.apiKey = apiKey;

  deps.db.transaction((tx) => {
    tx.update(providers)
      .set(patch)
      .where(and(eq(providers.id, id), eq(providers.userId, userId)))
      .run();

    tx.delete(providerModels).where(eq(providerModels.providerId, id)).run();
    tx.insert(providerModels)
      .values(input.models.map((model, index) => modelRow(userId, id, model, now, index)))
      .run();
  });

  return findProvider(deps, userId, id);
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

export async function resolveTarget(
  deps: ProviderDeps,
  userId: string,
  alias: string,
): Promise<ResolvedTarget | null> {
  const rows = await deps.db
    .select({
      modelId: providerModels.id,
      alias: providerModels.alias,
      upstreamModel: providerModels.upstreamModel,
      inputPricePerMtok: providerModels.inputPricePerMtok,
      outputPricePerMtok: providerModels.outputPricePerMtok,
      providerId: providers.id,
      providerName: providers.name,
      kind: providers.kind,
      baseUrl: providers.baseUrl,
      apiKey: providers.apiKey,
    })
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .where(
      and(
        eq(providerModels.userId, userId),
        eq(providerModels.alias, alias),
        eq(providerModels.enabled, true),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (row === undefined) return null;

  return {
    ...row,
    apiKey: row.apiKey === "" ? "" : await deps.sealer.open(row.apiKey),
  };
}

export async function listModelAliases(
  deps: ProviderDeps,
  userId: string,
): Promise<readonly { readonly alias: string; readonly createdAt: Date }[]> {
  return deps.db
    .select({ alias: providerModels.alias, createdAt: providerModels.createdAt })
    .from(providerModels)
    .where(and(eq(providerModels.userId, userId), eq(providerModels.enabled, true)))
    .orderBy(asc(providerModels.alias));
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
  model: ProviderInput["models"][number],
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
