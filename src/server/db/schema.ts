import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ProviderAuthMode, ProviderKind, ProviderOrigin } from "../../shared/providers";
import { user } from "./auth-schema";

export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().default(""),
    kind: text("kind").$type<ProviderKind>().notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key").notNull().default(""),
    authMode: text("auth_mode").$type<ProviderAuthMode>().notNull().default("api-key"),
    origin: text("origin").$type<ProviderOrigin>().notNull().default("custom"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("providers_user_name").on(table.userId, table.name),
    uniqueIndex("providers_user_slug")
      .on(table.userId, table.slug)
      .where(sql`${table.slug} <> ''`),
  ],
);

export const providerModels = sqliteTable(
  "provider_models",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    upstreamModel: text("upstream_model").notNull(),
    inputPricePerMtok: real("input_price_per_mtok"),
    outputPricePerMtok: real("output_price_per_mtok"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_models_user_alias").on(table.userId, table.alias),
    index("provider_models_provider").on(table.providerId),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("tags_user_slug").on(table.userId, table.slug)],
);

export const tagModels = sqliteTable(
  "tag_models",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    modelId: text("model_id")
      .notNull()
      .references(() => providerModels.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tagId, table.modelId] }),
    uniqueIndex("tag_models_tag_priority").on(table.tagId, table.priority),
    index("tag_models_model").on(table.modelId),
  ],
);

export type ProviderRow = typeof providers.$inferSelect;

export type ProviderModelRow = typeof providerModels.$inferSelect;
