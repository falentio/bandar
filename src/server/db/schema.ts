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
import type { CooldownSubject } from "../../shared/cooldowns";
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
    origin: text("origin").$type<ProviderOrigin>().notNull().default("custom"),
    failures: integer("failures").notNull().default(0),
    flaggedUntil: integer("flagged_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("providers_user_name").on(table.userId, table.name),
    uniqueIndex("providers_user_slug")
      .on(table.userId, table.slug)
      .where(sql`${table.slug} <> ''`),
  ],
);

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    credential: text("credential").notNull(),
    authMode: text("auth_mode").$type<ProviderAuthMode>().notNull().default("api-key"),
    priority: integer("priority").notNull(),
    failures: integer("failures").notNull().default(0),
    flaggedUntil: integer("flagged_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_credentials_provider_priority").on(table.providerId, table.priority),
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
    slug: text("slug").notNull(),
    alias: text("alias"),
    upstreamModel: text("upstream_model").notNull(),
    compat: text("compat"),
    inputPricePerMtok: real("input_price_per_mtok"),
    cacheInputPricePerMtok: real("cache_input_price_per_mtok"),
    outputPricePerMtok: real("output_price_per_mtok"),
    contextWindow: integer("context_window"),
    maxOutput: integer("max_output"),
    inputModalities: text("input_modalities"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    failures: integer("failures").notNull().default(0),
    flaggedUntil: integer("flagged_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_models_user_slug").on(table.userId, table.slug),
    uniqueIndex("provider_models_provider_upstream").on(table.providerId, table.upstreamModel),
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

export const cooldownEvents = sqliteTable(
  "cooldown_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subject: text("subject").$type<CooldownSubject>().notNull(),
    subjectName: text("subject_name").notNull(),
    providerId: text("provider_id").notNull(),
    providerName: text("provider_name").notNull(),
    modelId: text("model_id").notNull(),
    modelSlug: text("model_slug").notNull(),
    credentialId: text("credential_id"),
    credentialName: text("credential_name"),
    errorKind: text("error_kind").notNull(),
    errorMessage: text("error_message"),
    reference: text("reference").notNull(),
    failures: integer("failures").notNull(),
    cooldownMs: integer("cooldown_ms").notNull(),
    flaggedUntil: integer("flagged_until", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("cooldown_events_user_created").on(table.userId, table.createdAt)],
);

export type ProviderRow = typeof providers.$inferSelect;

export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;

export type ProviderModelRow = typeof providerModels.$inferSelect;
