import { getDatabase } from "./lib/db"
import {
    aiGatewayLog,
    runtimeLease,
    systemPrompt,
    type NewAiGatewayLog,
} from "../db/schema"
import { and, desc, eq, inArray, lt, sql as drizzleSql } from "drizzle-orm"
import type {
    OutputMetadata,
    StoredGenerationConfig,
    StoredGenerationError,
} from "../../schemas/image-generation"

export type GenerationBilling = {
    model?: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    priceUsd?: string
    priceSource?: 'gateway' | 'estimate' | 'unknown'
    gatewayGenerationId?: string
    usageJson?: Record<string, unknown>
}

type PendingGeneration = {
    prompt: string
    inputImages: string[]
    modelImages: string[]
    requestedModel: string
    effectiveModel: string
    batchId: string
    parentSystemPromptId?: number
    generationConfig: StoredGenerationConfig
}

type GenerationLog = Omit<NewAiGatewayLog, 'id' | 'systemPromptId' | 'createdAt'>

function normalizedTimestamps<T extends {createdAt: string; updatedAt?: string}>(row: T): T {
    return {
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
        ...(row.updatedAt ? {updatedAt: new Date(row.updatedAt).toISOString()} : {}),
    }
}

function billingValues(billing: GenerationBilling) {
    return {
        generationModel: billing.model,
        inputTokens: billing.inputTokens ?? null,
        outputTokens: billing.outputTokens ?? null,
        totalTokens: billing.totalTokens ?? null,
        cachedInputTokens: billing.cachedInputTokens ?? null,
        reasoningTokens: billing.reasoningTokens ?? null,
        priceUsd: billing.priceUsd ?? null,
        priceSource: billing.priceSource ?? null,
        gatewayGenerationId: billing.gatewayGenerationId ?? null,
        usageJson: billing.usageJson ?? null,
    }
}

export async function useDB(db = getDatabase()) {
    async function rowById(id: number) {
        const [row] = await db.select().from(systemPrompt).where(eq(systemPrompt.id, id)).limit(1)
        return row ? normalizedTimestamps(row) : undefined
    }

    async function requiredRowById(id: number) {
        const row = await rowById(id)
        if (!row) throw new Error(`Generation row ${id} was not found after persistence`)
        return row
    }

    function pendingValues(data: PendingGeneration) {
        return {
            TextPrompt: data.prompt,
            serverImages: data.inputImages,
            modelImages: data.modelImages,
            outputImage: '',
            generationModel: data.effectiveModel,
            status: 'pending' as const,
            batchId: data.batchId,
            parentSystemPromptId: data.parentSystemPromptId ?? null,
            generationConfig: data.generationConfig,
            errors: null,
            errorJson: null,
        }
    }

    async function createPendingGenerations(items: PendingGeneration[]) {
        if (items.length === 0) return []
        // A single INSERT commits all pending output rows atomically and returns
        // PostgreSQL generated IDs without connection-local SQLite state.
        const rows = await db.insert(systemPrompt).values(items.map(pendingValues)).returning()
        if (rows.length !== items.length) throw new Error('Database did not return all pending generations')
        return rows.map(normalizedTimestamps)
    }

    async function createPendingGeneration(data: PendingGeneration) {
        const [row] = await createPendingGenerations([data])
        if (!row) throw new Error('Database did not create the pending generation')
        return row
    }

    async function completeGeneration(
        id: number,
        data: {
            outputImage: string
            outputMetadata: OutputMetadata
            billing: GenerationBilling
            log: GenerationLog
        },
    ) {
        const transitionedRow = await db.transaction(async (tx) => {
            const [row] = await tx.update(systemPrompt).set({
                outputImage: data.outputImage,
                outputMetadata: data.outputMetadata,
                status: 'succeeded',
                errors: null,
                errorJson: null,
                ...billingValues(data.billing),
                updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
            }).where(and(
                eq(systemPrompt.id, id),
                eq(systemPrompt.status, 'pending'),
            )).returning()

            if (!row) return undefined

            await tx.insert(aiGatewayLog).values({
                ...data.log,
                systemPromptId: id,
            })
            return normalizedTimestamps(row)
        })
        if (transitionedRow) return {row: transitionedRow, transitioned: true}
        return {row: await requiredRowById(id), transitioned: false}
    }

    async function failGeneration(
        id: number,
        data: {
            error: StoredGenerationError
            billing?: GenerationBilling
            log: GenerationLog
        },
    ) {
        const billing = data.billing ?? {}
        const transitionedRow = await db.transaction(async (tx) => {
            const [row] = await tx.update(systemPrompt).set({
                outputImage: '',
                status: 'failed',
                errors: data.error.message,
                errorJson: data.error,
                ...billingValues(billing),
                updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
            }).where(and(
                eq(systemPrompt.id, id),
                eq(systemPrompt.status, 'pending'),
            )).returning()

            if (!row) return undefined

            await tx.insert(aiGatewayLog).values({
                ...data.log,
                systemPromptId: id,
            })
            return normalizedTimestamps(row)
        })
        if (transitionedRow) return {row: transitionedRow, transitioned: true}
        return {row: await requiredRowById(id), transitioned: false}
    }

    async function getSystemPrompt(id: number) {
        return rowById(id)
    }

    async function updateSystemPromptBilling(id: number, billing: GenerationBilling) {
        const values: Record<string, unknown> = {
            ...billingValues(billing),
            updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
        }
        if (!billing.model) delete values.generationModel
        if (!billing.gatewayGenerationId) delete values.gatewayGenerationId

        await db.update(systemPrompt)
            .set(values)
            .where(eq(systemPrompt.id, id))
        return rowById(id)
    }

    async function touchPendingGenerations(ids: number[]) {
        if (!ids.length) return 0
        const rows = await db.update(systemPrompt).set({
            updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
        }).where(and(
            inArray(systemPrompt.id, ids),
            eq(systemPrompt.status, 'pending'),
        )).returning({id: systemPrompt.id})
        return rows.length
    }

    async function getSystemPrompts(take = 50, skip = 0) {
        const limit = Math.max(1, Math.min(200, Math.floor(take)))
        const offset = Math.max(0, Math.floor(skip))
        // History is a compact replay/card projection. Large raw usage,
        // provider detail, output metadata, and structured errors are fetched
        // only through the single-record endpoint.
        const rows = await db.select({
            id: systemPrompt.id,
            TextPrompt: systemPrompt.TextPrompt,
            serverImages: systemPrompt.serverImages,
            modelImages: systemPrompt.modelImages,
            outputImage: systemPrompt.outputImage,
            generationModel: systemPrompt.generationModel,
            inputTokens: systemPrompt.inputTokens,
            outputTokens: systemPrompt.outputTokens,
            totalTokens: systemPrompt.totalTokens,
            cachedInputTokens: systemPrompt.cachedInputTokens,
            reasoningTokens: systemPrompt.reasoningTokens,
            priceUsd: systemPrompt.priceUsd,
            priceSource: systemPrompt.priceSource,
            gatewayGenerationId: systemPrompt.gatewayGenerationId,
            createdAt: systemPrompt.createdAt,
            updatedAt: systemPrompt.updatedAt,
            errors: systemPrompt.errors,
            status: systemPrompt.status,
            batchId: systemPrompt.batchId,
            parentSystemPromptId: systemPrompt.parentSystemPromptId,
            generationConfig: systemPrompt.generationConfig,
        }).from(systemPrompt)
            .orderBy(desc(systemPrompt.createdAt), desc(systemPrompt.id))
            .limit(limit)
            .offset(offset)
        return rows.map(normalizedTimestamps)
    }

    async function countSystemPrompts() {
        const [result] = await db.select({value: drizzleSql<number>`count(*)`}).from(systemPrompt)
        return Number(result?.value ?? 0)
    }

    async function reconcileStalePendingGenerations(staleTtlMs: number, nowMs = Date.now()) {
        const cutoff = new Date(nowMs - staleTtlMs).toISOString()
        const noLiveLease = drizzleSql`NOT EXISTS (
            SELECT 1 FROM ${runtimeLease}
            WHERE ${runtimeLease.owner}::text = ${systemPrompt.batchId}
            AND ${runtimeLease.expiresAt} > CURRENT_TIMESTAMP
        )`
        const interrupted = await db.select({
            id: systemPrompt.id,
            batchId: systemPrompt.batchId,
            generationModel: systemPrompt.generationModel,
            generationConfig: systemPrompt.generationConfig,
            TextPrompt: systemPrompt.TextPrompt,
            serverImages: systemPrompt.serverImages,
            modelImages: systemPrompt.modelImages,
        }).from(systemPrompt).where(and(
            eq(systemPrompt.status, 'pending'),
            lt(systemPrompt.updatedAt, cutoff),
            noLiveLease,
        )).orderBy(systemPrompt.updatedAt, systemPrompt.id).limit(100)
        if (!interrupted.length) return 0

        const error: StoredGenerationError = {
            name: 'InterruptedGenerationError',
            message: 'Generation was interrupted before it reached a durable completion state.',
            code: 'GENERATION_INTERRUPTED',
            retryable: true,
        }
        let reconciled = 0
        await db.transaction(async (tx) => {
            for (const row of interrupted) {
                const rows = await tx.update(systemPrompt).set({
                    outputImage: '',
                    status: 'failed',
                    errors: error.message,
                    errorJson: error,
                    updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
                }).where(and(
                    eq(systemPrompt.id, row.id),
                    eq(systemPrompt.status, 'pending'),
                    lt(systemPrompt.updatedAt, cutoff),
                    noLiveLease,
                )).returning({id: systemPrompt.id})
                if (rows.length === 0) continue
                reconciled += 1
                await tx.insert(aiGatewayLog).values({
                    systemPromptId: row.id,
                    batchId: row.batchId,
                    attemptNumber: 1,
                    status: 'error',
                    model: row.generationModel ?? row.generationConfig?.effectiveModel ?? 'unknown',
                    prompt: row.TextPrompt,
                    inputImages: row.serverImages,
                    modelImages: row.modelImages,
                    outputImage: null,
                    requestJson: row.generationConfig ?? null,
                    resolvedConfigJson: row.generationConfig,
                    responseJson: {reason: error.message},
                    error: error.message,
                    errorJson: error,
                })
            }
        })
        return reconciled
    }

    async function createAiGatewayLog(data: NewAiGatewayLog) {
        const [row] = await db.insert(aiGatewayLog).values(data).returning()
        if (!row) throw new Error('Database did not return the Gateway log')
        return normalizedTimestamps(row)
    }

    async function getAiGatewayLogs(limit = 50) {
        const rows = await db.select().from(aiGatewayLog)
            .orderBy(desc(aiGatewayLog.createdAt), desc(aiGatewayLog.id))
            .limit(Math.max(1, Math.min(200, limit)))
        return rows.map(normalizedTimestamps)
    }

    return {
        createPendingGeneration,
        createPendingGenerations,
        completeGeneration,
        failGeneration,
        getSystemPrompt,
        updateSystemPromptBilling,
        getSystemPrompts,
        countSystemPrompts,
        touchPendingGenerations,
        reconcileStalePendingGenerations,
        createAiGatewayLog,
        getAiGatewayLogs,
    }
}
