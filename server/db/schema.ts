import {sql} from "drizzle-orm";
import {sqliteTable, integer, text} from "drizzle-orm/sqlite-core";

export const systemPrompt = sqliteTable("systemPrompt", {
    id: integer("id").primaryKey({autoIncrement: true}),
    TextPrompt: text("TextPrompt").notNull(),
    // Store arrays as JSON in TEXT
    serverImages: text("serverImages", {mode: "json"}).$type<string[]>(),
    modelImages: text("modelImages", {mode: "json"}).$type<string[]>(),
    outputImage: text("outputImage").notNull(),
    createdAt: text("createdAt").default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: text("updatedAt").default(sql`CURRENT_TIMESTAMP`).notNull(),
    errors: text("errors"),
});

export type SystemPrompt = typeof systemPrompt.$inferSelect;
export type NewSystemPrompt = typeof systemPrompt.$inferInsert;
