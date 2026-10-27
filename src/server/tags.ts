import { and, asc, eq, inArray } from "drizzle-orm";
import { providerRefOf, tagRefOf } from "../shared/slugs";
import type { Tag, TagList } from "../shared/tags";
import type { Db } from "./db/client";
import { providerModels, providers, tagModels, tags } from "./db/schema";

export type TagDeps = { readonly db: Db };

export class TagRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagRuleError";
  }
}

export async function listTags(deps: TagDeps, userId: string): Promise<TagList> {
  const rows = await deps.db
    .select({
      tagId: tags.id,
      slug: tags.slug,
      createdAt: tags.createdAt,
      modelId: providerModels.id,
      alias: providerModels.alias,
      upstreamModel: providerModels.upstreamModel,
      priority: tagModels.priority,
      providerId: providers.id,
      providerName: providers.name,
      providerSlug: providers.slug,
    })
    .from(tags)
    .leftJoin(tagModels, eq(tagModels.tagId, tags.id))
    .leftJoin(providerModels, eq(providerModels.id, tagModels.modelId))
    .leftJoin(providers, eq(providers.id, providerModels.providerId))
    .where(eq(tags.userId, userId))
    .orderBy(asc(tags.slug), asc(tagModels.priority));

  const byId = new Map<string, Tag>();

  for (const row of rows) {
    const tag = byId.get(row.tagId) ?? {
      id: row.tagId,
      slug: row.slug,
      ref: tagRefOf(row.slug),
      createdAt: row.createdAt.toISOString(),
      models: [],
    };

    if (
      row.modelId !== null &&
      row.alias !== null &&
      row.priority !== null &&
      row.providerId !== null &&
      row.providerName !== null &&
      row.providerSlug !== null &&
      row.upstreamModel !== null
    ) {
      tag.models.push({
        modelId: row.modelId,
        alias: row.alias,
        upstreamModel: row.upstreamModel,
        ref: providerRefOf(row.providerSlug, row.upstreamModel),
        providerId: row.providerId,
        providerName: row.providerName,
        providerSlug: row.providerSlug,
        priority: row.priority,
      });
    }

    byId.set(row.tagId, tag);
  }

  return { tags: [...byId.values()] };
}

export async function createTag(deps: TagDeps, userId: string, slug: string): Promise<TagList> {
  deps.db
    .insert(tags)
    .values({ id: crypto.randomUUID(), userId, slug, createdAt: new Date() })
    .run();

  return listTags(deps, userId);
}

export async function removeTag(
  deps: TagDeps,
  userId: string,
  id: string,
): Promise<TagList | null> {
  const removed = await deps.db
    .delete(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning({ id: tags.id });

  return removed.length === 0 ? null : listTags(deps, userId);
}

export async function renumberTagPriorities(deps: TagDeps, userId: string): Promise<void> {
  const rows = await deps.db
    .select({ tagId: tagModels.tagId, modelId: tagModels.modelId, priority: tagModels.priority })
    .from(tagModels)
    .innerJoin(tags, eq(tags.id, tagModels.tagId))
    .where(eq(tags.userId, userId))
    .orderBy(asc(tagModels.tagId), asc(tagModels.priority));

  const byTag = new Map<string, { readonly modelId: string; readonly priority: number }[]>();

  for (const row of rows) {
    const list = byTag.get(row.tagId) ?? [];

    list.push({ modelId: row.modelId, priority: row.priority });
    byTag.set(row.tagId, list);
  }

  deps.db.transaction((tx) => {
    for (const [tagId, models] of byTag) {
      for (const [index, model] of models.entries()) {
        const priority = index + 1;

        if (model.priority === priority) continue;

        tx.update(tagModels)
          .set({ priority })
          .where(and(eq(tagModels.tagId, tagId), eq(tagModels.modelId, model.modelId)))
          .run();
      }
    }
  });
}

export async function setTagModels(
  deps: TagDeps,
  userId: string,
  tagId: string,
  modelIds: readonly string[],
): Promise<TagList | null> {
  const tagRows = await deps.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
    .limit(1);

  if (tagRows[0] === undefined) return null;

  const owned = await deps.db
    .select({ id: providerModels.id })
    .from(providerModels)
    .where(and(eq(providerModels.userId, userId), inArray(providerModels.id, [...modelIds])));

  if (owned.length !== modelIds.length) {
    throw new TagRuleError("every model in a tag must belong to this account");
  }

  deps.db.transaction((tx) => {
    tx.delete(tagModels).where(eq(tagModels.tagId, tagId)).run();

    tx.insert(tagModels)
      .values(modelIds.map((modelId, index) => ({ tagId, modelId, priority: index + 1 })))
      .run();
  });

  return listTags(deps, userId);
}
