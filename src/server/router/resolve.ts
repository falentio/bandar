import { and, asc, eq } from "drizzle-orm";
import { parseCompat, type Compat, type ProviderKind } from "../../shared/providers";
import { TAG_REF_PREFIX, providerRefOf, tagRefOf } from "../../shared/slugs";
import { providerCredentials, providerModels, providers, tagModels, tags } from "../db/schema";
import type { ProviderDeps } from "../providers";
import { isBuiltInProviderKind, type ProviderEndpoints } from "../providers/endpoints";

export type ResolvedAttempt = {
  readonly alias: string;
  readonly upstreamModel: string;
  readonly compat: Compat | null;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly credentialId: string | null;
  readonly credentialLabel: string;
  readonly sealedKey: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly providerFlaggedUntil: Date | null;
  readonly modelFlaggedUntil: Date | null;
  readonly credentialFlaggedUntil: Date | null;
};

export type ResolvedPlan = {
  readonly ref: string;
  readonly tag: string | null;
  readonly attempts: readonly ResolvedAttempt[];
};

export type ModelRef = { readonly id: string; readonly createdAt: Date };

type AttemptRow = {
  readonly alias: string;
  readonly upstreamModel: string;
  readonly compat: string | null;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly credentialId: string | null;
  readonly credentialLabel: string | null;
  readonly sealedKey: string | null;
  readonly modelId: string;
  readonly providerName: string;
  readonly providerFlaggedUntil: Date | null;
  readonly modelFlaggedUntil: Date | null;
  readonly credentialFlaggedUntil: Date | null;
};

const attemptColumns = {
  alias: providerModels.alias,
  upstreamModel: providerModels.upstreamModel,
  compat: providerModels.compat,
  inputPricePerMtok: providerModels.inputPricePerMtok,
  outputPricePerMtok: providerModels.outputPricePerMtok,
  providerId: providers.id,
  kind: providers.kind,
  baseUrl: providers.baseUrl,
  credentialId: providerCredentials.id,
  credentialLabel: providerCredentials.label,
  sealedKey: providerCredentials.credential,
  modelId: providerModels.id,
  providerName: providers.name,
  providerFlaggedUntil: providers.flaggedUntil,
  modelFlaggedUntil: providerModels.flaggedUntil,
  credentialFlaggedUntil: providerCredentials.flaggedUntil,
};

/** A provider with no credential row still answers, with an empty key. */
function attemptsOf(
  rows: readonly AttemptRow[],
  endpoints: ProviderEndpoints,
): readonly ResolvedAttempt[] {
  return rows.map((row) => ({
    ...row,
    baseUrl: isBuiltInProviderKind(row.kind) ? endpoints[row.kind].baseUrl : row.baseUrl,
    compat: parseCompat(row.compat),
    credentialLabel: row.credentialLabel ?? "",
    sealedKey: row.sealedKey ?? "",
  }));
}

export async function resolvePlan(
  deps: ProviderDeps,
  userId: string,
  ref: string,
): Promise<ResolvedPlan> {
  const aliasRows = await deps.db
    .select(attemptColumns)
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .leftJoin(providerCredentials, eq(providerCredentials.providerId, providers.id))
    .where(
      and(
        eq(providerModels.userId, userId),
        eq(providerModels.alias, ref),
        eq(providerModels.enabled, true),
      ),
    )
    .orderBy(asc(providerCredentials.priority));

  if (aliasRows.length > 0)
    return { ref, tag: null, attempts: attemptsOf(aliasRows, deps.endpoints) };

  if (ref.startsWith(TAG_REF_PREFIX)) {
    const slug = ref.slice(TAG_REF_PREFIX.length);

    const tagRows = await deps.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), eq(tags.slug, slug)))
      .limit(1);

    const tag = tagRows[0];

    if (tag === undefined) return { ref, tag: null, attempts: [] };

    const rows = await deps.db
      .select(attemptColumns)
      .from(tagModels)
      .innerJoin(providerModels, eq(providerModels.id, tagModels.modelId))
      .innerJoin(providers, eq(providers.id, providerModels.providerId))
      .leftJoin(providerCredentials, eq(providerCredentials.providerId, providers.id))
      .where(and(eq(tagModels.tagId, tag.id), eq(providerModels.enabled, true)))
      .orderBy(asc(tagModels.priority), asc(providerCredentials.priority));

    return { ref, tag: slug, attempts: attemptsOf(rows, deps.endpoints) };
  }

  const slash = ref.indexOf("/");

  if (slash <= 0) return { ref, tag: null, attempts: [] };

  const rows = await deps.db
    .select(attemptColumns)
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .leftJoin(providerCredentials, eq(providerCredentials.providerId, providers.id))
    .where(
      and(
        eq(providerModels.userId, userId),
        eq(providers.slug, ref.slice(0, slash)),
        eq(providerModels.upstreamModel, ref.slice(slash + 1)),
        eq(providerModels.enabled, true),
      ),
    )
    .orderBy(asc(providerCredentials.priority));

  return { ref, tag: null, attempts: attemptsOf(rows, deps.endpoints) };
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
