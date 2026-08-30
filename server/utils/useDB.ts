import { db } from "~~/server/utils/lib/db"
import {
    aiGatewayLog,
    systemPrompt,
    type NewAiGatewayLog,
} from "~~/server/db/schema"
import { and, desc, eq, inArray, lt, sql as drizzleSql } from "drizzle-orm"
import type {
    OutputMetadata,
    StoredGenerationConfig,
    StoredGenerationError,
} from "~~/schemas/image-generation"

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

function affectedRows(result: unknown) {
    const value = result as {rowsAffected?: number; changes?: number} | undefined
    return Number(value?.rowsAffected ?? value?.changes ?? 0)
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

export async function useDB() {
    async function rowById(id: number) {
        const [row] = await db.select().from(systemPrompt).where(eq(systemPrompt.id, id)).limit(1)
        return row
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
        const ids: number[] = []
        await db.transaction(async (tx) => {
            for (const item of items) {
                const result = await tx.insert(systemPrompt).values(pendingValues(item)).run()
                const id = Number((result as any)?.lastInsertRowid ?? 0)
                if (!id) throw new Error('Database did not return an id for a pending generation')
                ids.push(id)
            }
        })
        return Promise.all(ids.map(requiredRowById))
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
            }).run()
            return row
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
            }).run()
            return row
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
            .run()
        return rowById(id)
    }

    async function touchPendingGenerations(ids: number[]) {
        if (!ids.length) return 0
        const result = await db.update(systemPrompt).set({
            updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
        }).where(and(
            inArray(systemPrompt.id, ids),
            eq(systemPrompt.status, 'pending'),
        )).run()
        return affectedRows(result)
    }

    async function getSystemPrompts(take = 50, skip = 0) {
        const limit = Math.max(1, Math.min(200, Math.floor(take)))
        const offset = Math.max(0, Math.floor(skip))
        // History is a compact replay/card projection. Large raw usage,
        // provider detail, output metadata, and structured errors are fetched
        // only through the single-record endpoint.
        return db.select({
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
    }

    async function countSystemPrompts() {
        const [result] = await db.select({value: drizzleSql<number>`count(*)`}).from(systemPrompt)
        return Number(result?.value ?? 0)
    }

    async function reconcileStalePendingGenerations(staleTtlMs: number, nowMs = Date.now()) {
        const cutoff = new Date(nowMs - staleTtlMs).toISOString().replace('T', ' ').slice(0, 19)
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
                const result = await tx.update(systemPrompt).set({
                    outputImage: '',
                    status: 'failed',
                    errors: error.message,
                    errorJson: error,
                    updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
                }).where(and(
                    eq(systemPrompt.id, row.id),
                    eq(systemPrompt.status, 'pending'),
                    lt(systemPrompt.updatedAt, cutoff),
                )).run()
                if (affectedRows(result) === 0) continue
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
                }).run()
            }
        })
        return reconciled
    }

    async function createAiGatewayLog(data: NewAiGatewayLog) {
        const result = await db.insert(aiGatewayLog).values(data).run()
        const id = Number((result as any)?.lastInsertRowid ?? 0)
        if (!id) throw new Error('Database did not return an id for the Gateway log')
        const [row] = await db.select().from(aiGatewayLog).where(eq(aiGatewayLog.id, id))
        return row
    }

    async function getAiGatewayLogs(limit = 50) {
        return db.select().from(aiGatewayLog)
            .orderBy(desc(aiGatewayLog.createdAt), desc(aiGatewayLog.id))
            .limit(Math.max(1, Math.min(200, limit)))
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
