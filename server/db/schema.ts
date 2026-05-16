import {sql} from "drizzle-orm";
import {sqliteTable, integer, text} from "drizzle-orm/sqlite-core";

export const systemPrompt = sqliteTable("systemPrompt", {
    id: integer("id").primaryKey({autoIncrement: true}),
    TextPrompt: text("TextPrompt").notNull(),
    // Store arrays as JSON in TEXT
    serverImages: text("serverImages", {mode: "json"}).$type<string[]>(),
    modelImages: text("modelImages", {mode: "json"}).$type<string[]>(),
    outputImage: text("outputImage").notNull(),
    generationModel: text("generationModel"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    cachedInputTokens: integer("cachedInputTokens"),
    reasoningTokens: integer("reasoningTokens"),
    priceUsd: text("priceUsd"),
    priceSource: text("priceSource"),
    gatewayGenerationId: text("gatewayGenerationId"),
    usageJson: text("usageJson", {mode: "json"}).$type<Record<string, unknown>>(),
    createdAt: text("createdAt").default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: text("updatedAt").default(sql`CURRENT_TIMESTAMP`).notNull(),
    errors: text("errors"),
});

export const aiGatewayLog = sqliteTable("aiGatewayLog", {
    id: integer("id").primaryKey({autoIncrement: true}),
    systemPromptId: integer("systemPromptId"),
    status: text("status").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    inputImages: text("inputImages", {mode: "json"}).$type<string[]>(),
    modelImages: text("modelImages", {mode: "json"}).$type<string[]>(),
    outputImage: text("outputImage"),
    outputMimeType: text("outputMimeType"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    priceUsd: text("priceUsd"),
    priceSource: text("priceSource"),
    gatewayGenerationId: text("gatewayGenerationId"),
    requestJson: text("requestJson", {mode: "json"}).$type<Record<string, unknown>>(),
    responseJson: text("responseJson", {mode: "json"}).$type<Record<string, unknown>>(),
    error: text("error"),
    durationMs: integer("durationMs"),
    createdAt: text("createdAt").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type SystemPrompt = typeof systemPrompt.$inferSelect;
export type NewSystemPrompt = typeof systemPrompt.$inferInsert;
export type AiGatewayLog = typeof aiGatewayLog.$inferSelect;
export type NewAiGatewayLog = typeof aiGatewayLog.$inferInsert;
