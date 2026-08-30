import {sql} from "drizzle-orm";
import {sqliteTable, integer, text, index} from "drizzle-orm/sqlite-core";
import type {
    OutputMetadata,
    StoredGenerationConfig,
    StoredGenerationError,
} from "~~/schemas/image-generation";

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
    status: text("status").$type<'pending' | 'succeeded' | 'failed'>(),
    batchId: text("batchId"),
    parentSystemPromptId: integer("parentSystemPromptId"),
    generationConfig: text("generationConfig", {mode: "json"}).$type<StoredGenerationConfig>(),
    outputMetadata: text("outputMetadata", {mode: "json"}).$type<OutputMetadata>(),
    errorJson: text("errorJson", {mode: "json"}).$type<StoredGenerationError>(),
}, (table) => [
    index("systemPrompt_batchId_idx").on(table.batchId),
    index("systemPrompt_parentSystemPromptId_idx").on(table.parentSystemPromptId),
    index("systemPrompt_status_updatedAt_idx").on(table.status, table.updatedAt),
]);

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
    batchId: text("batchId"),
    attemptNumber: integer("attemptNumber"),
    providerRequestId: text("providerRequestId"),
    resolvedConfigJson: text("resolvedConfigJson", {mode: "json"}).$type<StoredGenerationConfig>(),
    errorJson: text("errorJson", {mode: "json"}).$type<StoredGenerationError>(),
    createdAt: text("createdAt").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    index("aiGatewayLog_systemPromptId_idx").on(table.systemPromptId),
    index("aiGatewayLog_batchId_idx").on(table.batchId),
    index("aiGatewayLog_gatewayGenerationId_idx").on(table.gatewayGenerationId),
]);

export type SystemPrompt = typeof systemPrompt.$inferSelect;
export type NewSystemPrompt = typeof systemPrompt.$inferInsert;
export type AiGatewayLog = typeof aiGatewayLog.$inferSelect;
export type NewAiGatewayLog = typeof aiGatewayLog.$inferInsert;
