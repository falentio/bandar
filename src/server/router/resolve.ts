import { and, asc, eq, inArray } from "drizzle-orm";
import type { ProviderAuthMode, ProviderKind } from "../../shared/providers";
import { TAG_REF_PREFIX, providerRefOf, tagRefOf } from "../../shared/slugs";
import { providerCredentials, providerModels, providers, tagModels, tags } from "../db/schema";
import type { ProviderDeps } from "../providers";

export type ResolvedCredential = {
  readonly id: string;
  readonly sealedKey: string;
  readonly authMode: ProviderAuthMode;
  readonly failures: number;
  readonly flaggedUntil: Date | null;
};

export type ResolvedCandidate = {
  readonly modelId: string;
  readonly alias: string;
  readonly upstreamModel: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly providerFailures: number;
  readonly providerFlaggedUntil: Date | null;
  readonly modelFailures: number;
  readonly modelFlaggedUntil: Date | null;
  readonly credentials: readonly ResolvedCredential[];
};

export type ResolvedPlan = {
  readonly ref: string;
  readonly tag: string | null;
  readonly candidates: readonly ResolvedCandidate[];
};

export type ModelRef = { readonly id: string; readonly createdAt: Date };

type CandidateRow = {
  readonly modelId: string;
  readonly alias: string;
  readonly upstreamModel: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly providerFailures: number;
  readonly providerFlaggedUntil: Date | null;
  readonly modelFailures: number;
  readonly modelFlaggedUntil: Date | null;
};

const candidateColumns = {
  modelId: providerModels.id,
  alias: providerModels.alias,
  upstreamModel: providerModels.upstreamModel,
  inputPricePerMtok: providerModels.inputPricePerMtok,
  outputPricePerMtok: providerModels.outputPricePerMtok,
  providerId: providers.id,
  kind: providers.kind,
  baseUrl: providers.baseUrl,
  providerFailures: providers.failures,
  providerFlaggedUntil: providers.flaggedUntil,
  modelFailures: providerModels.failures,
  modelFlaggedUntil: providerModels.flaggedUntil,
};

export async function resolvePlan(
  deps: ProviderDeps,
  userId: string,
  ref: string,
): Promise<ResolvedPlan> {
  const aliasRows = await deps.db
    .select(candidateColumns)
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .where(
      and(
        eq(providerModels.userId, userId),
        eq(providerModels.alias, ref),
        eq(providerModels.enabled, true),
      ),
    )
    .limit(1);

  const alias = aliasRows[0];

  if (alias !== undefined) {
    return { ref, tag: null, candidates: await withCredentials(deps, [alias]) };
  }

  if (ref.startsWith(TAG_REF_PREFIX)) {
    const slug = ref.slice(TAG_REF_PREFIX.length);

    const tagRows = await deps.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), eq(tags.slug, slug)))
      .limit(1);

    const tag = tagRows[0];

    if (tag === undefined) return { ref, tag: null, candidates: [] };

    const rows = await deps.db
      .select(candidateColumns)
      .from(tagModels)
      .innerJoin(providerModels, eq(providerModels.id, tagModels.modelId))
      .innerJoin(providers, eq(providers.id, providerModels.providerId))
      .where(and(eq(tagModels.tagId, tag.id), eq(providerModels.enabled, true)))
      .orderBy(asc(tagModels.priority));

    return { ref, tag: slug, candidates: await withCredentials(deps, rows) };
  }

  const slash = ref.indexOf("/");

  if (slash <= 0) return { ref, tag: null, candidates: [] };

  const rows = await deps.db
    .select(candidateColumns)
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .where(
      and(
        eq(providerModels.userId, userId),
        eq(providers.slug, ref.slice(0, slash)),
        eq(providerModels.upstreamModel, ref.slice(slash + 1)),
        eq(providerModels.enabled, true),
      ),
    )
    .orderBy(asc(providerModels.createdAt))
    .limit(1);

  return { ref, tag: null, candidates: await withCredentials(deps, rows) };
}

async function withCredentials(
  deps: ProviderDeps,
  rows: readonly CandidateRow[],
): Promise<readonly ResolvedCandidate[]> {
  if (rows.length === 0) return [];

  const providerIds: string[] = [];

  for (const row of rows) {
    if (!providerIds.includes(row.providerId)) providerIds.push(row.providerId);
  }

  const credentialRows = await deps.db
    .select({
      id: providerCredentials.id,
      providerId: providerCredentials.providerId,
      sealedKey: providerCredentials.sealedKey,
      authMode: providerCredentials.authMode,
      failures: providerCredentials.failures,
      flaggedUntil: providerCredentials.flaggedUntil,
    })
    .from(providerCredentials)
    .where(inArray(providerCredentials.providerId, providerIds))
    .orderBy(asc(providerCredentials.createdAt), asc(providerCredentials.id));

  const grouped = new Map<string, ResolvedCredential[]>();

  for (const row of credentialRows) {
    const list = grouped.get(row.providerId) ?? [];

    list.push({
      id: row.id,
      sealedKey: row.sealedKey,
      authMode: row.authMode,
      failures: row.failures,
      flaggedUntil: row.flaggedUntil,
    });
    grouped.set(row.providerId, list);
  }

  return rows.map((row) => ({ ...row, credentials: grouped.get(row.providerId) ?? [] }));
}

export async function listModelRefs(
  deps: ProviderDeps,
  userId: string,
): Promise<readonly ModelRef[]> {
  const modelRows = await deps.db
    .select({
      alias: providerModels.alias,
      upstreamModel: providerModels.upstreamModel,
      providerSlug: providers.slug,
      createdAt: providerModels.createdAt,
    })
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .where(and(eq(providerModels.userId, userId), eq(providerModels.enabled, true)));

  const aliases = modelRows.map((row): ModelRef => ({ id: row.alias, createdAt: row.createdAt }));
  const aliasIds = new Set(aliases.map((model) => model.id));

  const providerRefs = modelRows.flatMap((row): ModelRef[] => {
    if (row.providerSlug === "") return [];

    const ref = providerRefOf(row.providerSlug, row.upstreamModel);

    return aliasIds.has(ref) ? [] : [{ id: ref, createdAt: row.createdAt }];
  });

  const tagRows = await deps.db
    .select({ slug: tags.slug, createdAt: tags.createdAt })
    .from(tags)
    .innerJoin(tagModels, eq(tagModels.tagId, tags.id))
    .innerJoin(providerModels, eq(providerModels.id, tagModels.modelId))
    .where(and(eq(tags.userId, userId), eq(providerModels.enabled, true)))
    .groupBy(tags.id, tags.slug, tags.createdAt);

  const tagRefs = tagRows.map((row): ModelRef => ({
    id: tagRefOf(row.slug),
    createdAt: row.createdAt,
  }));

  const byId = new Map<string, ModelRef>();

  for (const model of [...aliases, ...tagRefs, ...providerRefs]) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }

  return [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}
