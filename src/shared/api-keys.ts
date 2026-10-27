import * as v from "valibot";
import { API_PREFIX } from "./api";

export const API_KEY_HEADER = "x-api-key";

export const API_KEY_NAME_MAX = 32;

export const apiKeyPaths = {
  create: `${API_PREFIX}/auth/api-key/create`,
  list: `${API_PREFIX}/auth/api-key/list`,
  remove: `${API_PREFIX}/auth/api-key/delete`,
};

export const ApiKeySchema = v.object({
  id: v.string(),
  name: v.nullable(v.string()),
  start: v.nullable(v.string()),
  createdAt: v.string(),
  lastRequest: v.optional(v.nullable(v.string())),
});

export const ApiKeyListSchema = v.object({
  apiKeys: v.array(ApiKeySchema),
  total: v.number(),
});

export const CreatedApiKeySchema = v.object({
  id: v.string(),
  key: v.string(),
  name: v.optional(v.nullable(v.string())),
  start: v.optional(v.nullable(v.string())),
  createdAt: v.string(),
});

export const ApiKeyCreateInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(API_KEY_NAME_MAX)),
});

export type ApiKey = v.InferOutput<typeof ApiKeySchema>;

export type ApiKeyList = v.InferOutput<typeof ApiKeyListSchema>;

export type CreatedApiKey = v.InferOutput<typeof CreatedApiKeySchema>;

export type ApiKeyCreateInput = v.InferOutput<typeof ApiKeyCreateInputSchema>;
