import * as v from "valibot";
import { SlugSchema } from "./slugs";

export const TagModelSchema = v.object({
  modelId: v.string(),
  alias: v.string(),
  upstreamModel: v.string(),
  ref: v.string(),
  providerId: v.string(),
  providerName: v.string(),
  providerSlug: v.string(),
  priority: v.number(),
});

export const TagSchema = v.object({
  id: v.string(),
  slug: SlugSchema,
  ref: v.string(),
  createdAt: v.string(),
  models: v.array(TagModelSchema),
});

export const TagListSchema = v.object({
  tags: v.array(TagSchema),
});

export const TagCreateInputSchema = v.object({ slug: SlugSchema });

export const TagModelsInputSchema = v.object({
  modelIds: v.pipe(
    v.array(v.string()),
    v.minLength(1),
    v.maxLength(100),
    v.check((ids) => new Set(ids).size === ids.length, "list each model once"),
  ),
});

export const TagParamsSchema = v.object({ id: v.string() });

export const tagPaths = {
  list: "/api/tags",
  create: "/api/tags",
  remove: (id: string) => `/api/tags/${id}`,
  models: (id: string) => `/api/tags/${id}/models`,
};

export type TagModel = v.InferOutput<typeof TagModelSchema>;

export type Tag = v.InferOutput<typeof TagSchema>;

export type TagList = v.InferOutput<typeof TagListSchema>;

export type TagCreateInput = v.InferOutput<typeof TagCreateInputSchema>;

export type TagModelsInput = v.InferOutput<typeof TagModelsInputSchema>;

export type TagParams = v.InferOutput<typeof TagParamsSchema>;
