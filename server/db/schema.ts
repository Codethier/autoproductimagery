import {pgTable, serial, integer, text, jsonb, timestamp, uuid, index} from "drizzle-orm/pg-core";
import type {
    OutputMetadata,
    StoredGenerationConfig,
    StoredGenerationError,
} from "~~/schemas/image-generation";

export const systemPrompt = pgTable("systemPrompt", {
    id: serial("id").primaryKey(),
    TextPrompt: text("TextPrompt").notNull(),
    serverImages: jsonb("serverImages").$type<string[]>(),
    modelImages: jsonb("modelImages").$type<string[]>(),
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
    usageJson: jsonb("usageJson").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt", {mode: "string", withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", {mode: "string", withTimezone: true}).defaultNow().notNull(),
    errors: text("errors"),
    status: text("status").$type<'pending' | 'succeeded' | 'failed'>(),
    batchId: text("batchId"),
    parentSystemPromptId: integer("parentSystemPromptId"),
    generationConfig: jsonb("generationConfig").$type<StoredGenerationConfig>(),
    outputMetadata: jsonb("outputMetadata").$type<OutputMetadata>(),
    errorJson: jsonb("errorJson").$type<StoredGenerationError>(),
}, (table) => [
    index("systemPrompt_batchId_idx").on(table.batchId),
    index("systemPrompt_parentSystemPromptId_idx").on(table.parentSystemPromptId),
    index("systemPrompt_status_updatedAt_idx").on(table.status, table.updatedAt),
]);

export const aiGatewayLog = pgTable("aiGatewayLog", {
    id: serial("id").primaryKey(),
    systemPromptId: integer("systemPromptId"),
    status: text("status").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    inputImages: jsonb("inputImages").$type<string[]>(),
    modelImages: jsonb("modelImages").$type<string[]>(),
    outputImage: text("outputImage"),
    outputMimeType: text("outputMimeType"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    priceUsd: text("priceUsd"),
    priceSource: text("priceSource"),
    gatewayGenerationId: text("gatewayGenerationId"),
    requestJson: jsonb("requestJson").$type<Record<string, unknown>>(),
    responseJson: jsonb("responseJson").$type<Record<string, unknown>>(),
    error: text("error"),
    durationMs: integer("durationMs"),
    batchId: text("batchId"),
    attemptNumber: integer("attemptNumber"),
    providerRequestId: text("providerRequestId"),
    resolvedConfigJson: jsonb("resolvedConfigJson").$type<StoredGenerationConfig>(),
    errorJson: jsonb("errorJson").$type<StoredGenerationError>(),
    createdAt: timestamp("createdAt", {mode: "string", withTimezone: true}).defaultNow().notNull(),
}, (table) => [
    index("aiGatewayLog_systemPromptId_idx").on(table.systemPromptId),
    index("aiGatewayLog_batchId_idx").on(table.batchId),
    index("aiGatewayLog_gatewayGenerationId_idx").on(table.gatewayGenerationId),
]);

export type SystemPrompt = typeof systemPrompt.$inferSelect;

// Shared capacity and credential-attempt accounting must survive warm-worker
// eviction and coordinate across independently scaled serverless instances.
export const runtimeLease = pgTable("runtime_lease", {
    id: uuid("id").primaryKey(),
    scope: text("scope").notNull(),
    owner: uuid("owner").notNull(),
    state: text("state").$type<'queued' | 'running'>().notNull(),
    expiresAt: timestamp("expires_at", {mode: "string", withTimezone: true}).notNull(),
    createdAt: timestamp("created_at", {mode: "string", withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {mode: "string", withTimezone: true}).defaultNow().notNull(),
}, (table) => [
    index("runtime_lease_scope_state_expires_idx").on(table.scope, table.state, table.expiresAt),
    index("runtime_lease_owner_expires_idx").on(table.owner, table.expiresAt),
]);

export const durableLoginAttempt = pgTable("login_attempt", {
    key: text("key").primaryKey(),
    attempts: integer("attempts").default(0).notNull(),
    resetAt: timestamp("reset_at", {mode: "string", withTimezone: true}).notNull(),
    updatedAt: timestamp("updated_at", {mode: "string", withTimezone: true}).defaultNow().notNull(),
}, (table) => [
    index("login_attempt_reset_idx").on(table.resetAt),
]);
export type NewSystemPrompt = typeof systemPrompt.$inferInsert;
export type AiGatewayLog = typeof aiGatewayLog.$inferSelect;
export type NewAiGatewayLog = typeof aiGatewayLog.$inferInsert;
