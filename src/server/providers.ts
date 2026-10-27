import { and, asc, eq } from "drizzle-orm";
import * as v from "valibot";
import type {
  Provider,
  ProviderAuthMode,
  ProviderInput,
  ProviderKind,
  ProviderList,
  ProviderModelInput,
} from "../shared/providers";
import { parseCredential, type Credential } from "./credential";
import { KILO_MODELS_URL } from "./router/adapters/kilocode";
import type { Db } from "./db/client";
import { UpstreamError } from "./router/types";
import { providerModels, providers } from "./db/schema";
import type { Sealer } from "./seal";

export type ProviderDeps = { readonly db: Db; readonly sealer: Sealer };

type ProviderPatch = {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authMode?: ProviderAuthMode;
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
  readonly credential: Credential;
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
  input: ProviderInput,
): Promise<Provider> {
  const id = crypto.randomUUID();
  const now = new Date();

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
        kind: input.kind,
        baseUrl: input.baseUrl,
        apiKey,
        authMode: "api-key",
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

  const { apiKey, ...rest } = row;

  return { ...rest, credential: await readCredential(deps, apiKey) };
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

export async function readCredential(deps: ProviderDeps, sealed: string): Promise<Credential> {
  if (sealed === "") return { authMode: "api-key", apiKey: "" };

  const plaintext = await deps.sealer.open(sealed);

  const credential = parseCredential(plaintext);

  // A key saved before credentials carried an auth mode is a bare key.
  return credential ?? { authMode: "api-key", apiKey: plaintext };
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
