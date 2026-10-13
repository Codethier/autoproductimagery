import {pgTable, serial, integer, text, jsonb, timestamp, uuid, index, uniqueIndex, boolean, bigint, numeric, check, type AnyPgColumn} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import type {
    OutputMetadata,
    StoredGenerationConfig,
    StoredGenerationError,
} from "~~/schemas/image-generation";

export const organizations = pgTable('organization', {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    isBootstrap: boolean('is_bootstrap').default(false).notNull(),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [uniqueIndex('organization_bootstrap_unique').on(table.isBootstrap).where(sql`${table.isBootstrap} = true`)]);

export const users = pgTable('app_user', {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    username: text('username').notNull(),
    normalizedUsername: text('normalized_username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<'owner' | 'user'>().notNull(),
    isBootstrapOwner: boolean('is_bootstrap_owner').default(false).notNull(),
    disabledAt: timestamp('disabled_at', {mode: 'string', withTimezone: true}),
    authVersion: integer('auth_version').default(1).notNull(),
    creditBalanceUnits: numeric('credit_balance_units', {precision: 30, scale: 0}),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [
    uniqueIndex('app_user_username_unique').on(table.normalizedUsername),
    uniqueIndex('app_user_bootstrap_unique').on(table.isBootstrapOwner).where(sql`${table.isBootstrapOwner} = true`),
    index('app_user_organization_idx').on(table.organizationId, table.createdAt, table.id),
    check('app_user_role_check', sql`${table.role} IN ('owner', 'user')`),
]);

export const accountSessions = pgTable('account_session', {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    tokenHash: text('token_hash').notNull(),
    authVersion: integer('auth_version').notNull(),
    expiresAt: timestamp('expires_at', {mode: 'string', withTimezone: true}).notNull(),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [
    uniqueIndex('account_session_token_unique').on(table.tokenHash),
    index('account_session_user_idx').on(table.userId),
    index('account_session_expiry_idx').on(table.expiresAt),
]);

export const assets = pgTable('asset', {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
    parentId: uuid('parent_id').references((): AnyPgColumn => assets.id),
    name: text('name').notNull(),
    kind: text('kind').$type<'file' | 'folder'>().notNull(),
    url: text('url').notNull(),
    category: text('category').$type<'uploaded' | 'generated'>().default('uploaded').notNull(),
    byteSize: bigint('byte_size', {mode: 'number'}),
    mimeType: text('mime_type'),
    width: integer('width'),
    height: integer('height'),
    deletedAt: timestamp('deleted_at', {mode: 'string', withTimezone: true}),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [
    uniqueIndex('asset_url_unique').on(table.url).where(sql`${table.deletedAt} IS NULL`),
    index('asset_owner_parent_idx').on(table.organizationId, table.ownerUserId, table.parentId, table.name),
    index('asset_parent_idx').on(table.parentId),
    check('asset_kind_check', sql`${table.kind} IN ('file', 'folder')`),
    check('asset_category_check', sql`${table.category} IN ('uploaded', 'generated')`),
]);

export const assetShares = pgTable('asset_share', {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => assets.id, {onDelete: 'cascade'}),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    sharedByUserId: uuid('shared_by_user_id').notNull().references(() => users.id),
    recipientUserId: uuid('recipient_user_id').notNull().references(() => users.id),
    permission: text('permission').$type<'view' | 'edit'>().notNull(),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [
    uniqueIndex('asset_share_recipient_unique').on(table.assetId, table.recipientUserId),
    index('asset_share_org_recipient_idx').on(table.organizationId, table.recipientUserId),
    check('asset_share_permission_check', sql`${table.permission} IN ('view', 'edit')`),
]);

export const systemPrompt = pgTable("systemPrompt", {
    id: serial("id").primaryKey(),
    organizationId: uuid('organizationId').references(() => organizations.id),
    userId: uuid('userId').references(() => users.id),
    TextPrompt: text("TextPrompt").notNull(),
    serverImages: jsonb("serverImages").$type<string[]>(),
    modelImages: jsonb("modelImages").$type<string[]>(),
    outputImage: text("outputImage").notNull(),
    outputImageDeletedAt: timestamp("outputImageDeletedAt", {mode: "string", withTimezone: true}),
    generationModel: text("generationModel"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    cachedInputTokens: integer("cachedInputTokens"),
    reasoningTokens: integer("reasoningTokens"),
    priceUsd: text("priceUsd"),
    priceSource: text("priceSource"),
    billingState: text('billingState').$type<'pending' | 'awaiting' | 'confirmed' | 'released'>(),
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
    index('systemPrompt_user_history_idx').on(table.organizationId, table.userId, table.createdAt, table.id),
    index("systemPrompt_batchId_idx").on(table.batchId),
    index("systemPrompt_parentSystemPromptId_idx").on(table.parentSystemPromptId),
    index("systemPrompt_status_updatedAt_idx").on(table.status, table.updatedAt),
    index("systemPrompt_outputImage_idx").on(table.outputImage),
    index("systemPrompt_image_retention_idx").on(table.createdAt, table.id).where(sql`${table.outputImageDeletedAt} IS NULL AND ${table.outputImage} <> '' AND (${table.status} = 'succeeded' OR ${table.status} IS NULL)`),
]);

export const aiGatewayLog = pgTable("aiGatewayLog", {
    id: serial("id").primaryKey(),
    organizationId: uuid('organizationId').references(() => organizations.id),
    userId: uuid('userId').references(() => users.id),
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
    index('aiGatewayLog_user_history_idx').on(table.organizationId, table.userId, table.createdAt, table.id),
    index("aiGatewayLog_systemPromptId_idx").on(table.systemPromptId),
    index("aiGatewayLog_batchId_idx").on(table.batchId),
    index("aiGatewayLog_gatewayGenerationId_idx").on(table.gatewayGenerationId),
]);

export type SystemPrompt = typeof systemPrompt.$inferSelect;

// One charge per durable output row, including failed outputs that incurred a
// provider charge. Repeated Gateway reconciliation cannot post it twice.
export const accountGenerationCharges = pgTable('account_generation_charge', {
    generationId: integer('generation_id').primaryKey().references(() => systemPrompt.id),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    state: text('state').$type<'outstanding' | 'confirmed' | 'released'>().notNull().default('outstanding'),
    estimatedUnits: numeric('estimated_units', {precision: 30, scale: 0}),
    confirmedUnits: numeric('confirmed_units', {precision: 30, scale: 0}),
    gatewayGenerationId: text('gateway_generation_id'),
    confirmedAt: timestamp('confirmed_at', {mode: 'string', withTimezone: true}),
    nextCheckAt: timestamp('next_check_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
    checkAttempts: integer('check_attempts').default(0).notNull(),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', {mode: 'string', withTimezone: true}),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [
    index('account_charge_owner_state_idx').on(table.organizationId, table.userId, table.state, table.nextCheckAt),
    index('account_charge_gateway_idx').on(table.organizationId, table.userId, table.gatewayGenerationId),
    check('account_charge_state_check', sql`${table.state} IN ('outstanding', 'confirmed', 'released')`),
    check('account_charge_amount_check', sql`(${table.estimatedUnits} IS NULL OR ${table.estimatedUnits} >= 0) AND (${table.confirmedUnits} IS NULL OR ${table.confirmedUnits} >= 0)`),
    check('account_charge_confirmation_check', sql`(${table.state} = 'confirmed') = (${table.confirmedUnits} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL)`),
]);

export const accountBalanceAdjustments = pgTable('account_balance_adjustment', {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    adjustedByUserId: uuid('adjusted_by_user_id').notNull().references(() => users.id),
    previousUnits: numeric('previous_units', {precision: 30, scale: 0}),
    actualUnits: numeric('actual_units', {precision: 30, scale: 0}),
    createdAt: timestamp('created_at', {mode: 'string', withTimezone: true}).defaultNow().notNull(),
}, table => [index('account_balance_adjustment_owner_idx').on(table.organizationId, table.userId, table.createdAt)]);

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
