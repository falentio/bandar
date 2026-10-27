import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ProviderAuthMode, ProviderKind } from "../../shared/providers";
import { user } from "./auth-schema";

export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<ProviderKind>().notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key").notNull().default(""),
    authMode: text("auth_mode").$type<ProviderAuthMode>().notNull().default("api-key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("providers_user_name").on(table.userId, table.name)],
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

export type ProviderRow = typeof providers.$inferSelect;

export type ProviderModelRow = typeof providerModels.$inferSelect;
