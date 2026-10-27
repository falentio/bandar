import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type NoteRow = typeof notes.$inferSelect;
