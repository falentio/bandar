import { and, asc, eq } from "drizzle-orm";
import type { ProviderKind } from "../../shared/providers";
import { TAG_REF_PREFIX, providerRefOf, tagRefOf } from "../../shared/slugs";
import { providerModels, providers, tagModels, tags } from "../db/schema";
import type { ProviderDeps } from "../providers";

export type ResolvedCandidate = {
  readonly modelId: string;
  readonly alias: string;
  readonly upstreamModel: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerSlug: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly sealedKey: string;
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
  readonly providerName: string;
  readonly providerSlug: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly sealedKey: string;
};

const candidateColumns = {
  modelId: providerModels.id,
  alias: providerModels.alias,
  upstreamModel: providerModels.upstreamModel,
  inputPricePerMtok: providerModels.inputPricePerMtok,
  outputPricePerMtok: providerModels.outputPricePerMtok,
  providerId: providers.id,
  providerName: providers.name,
  providerSlug: providers.slug,
  kind: providers.kind,
  baseUrl: providers.baseUrl,
  sealedKey: providers.apiKey,
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

  if (alias !== undefined) return { ref, tag: null, candidates: [candidate(alias)] };

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

    return { ref, tag: slug, candidates: rows.map(candidate) };
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

  return { ref, tag: null, candidates: rows.map(candidate) };
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

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function candidate(row: CandidateRow): ResolvedCandidate {
  return {
    modelId: row.modelId,
    alias: row.alias,
    upstreamModel: row.upstreamModel,
    inputPricePerMtok: row.inputPricePerMtok,
    outputPricePerMtok: row.outputPricePerMtok,
    providerId: row.providerId,
    providerName: row.providerName,
    providerSlug: row.providerSlug,
    kind: row.kind,
    baseUrl: row.baseUrl,
    sealedKey: row.sealedKey,
  };
}
