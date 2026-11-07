import { getDatabase } from "./lib/db"
import {
    aiGatewayLog,
    runtimeLease,
    pipelineRunSteps,
    systemPrompt,
    type NewAiGatewayLog,
} from "../db/schema"
import { and, desc, eq, inArray, isNotNull, lt, sql as drizzleSql } from "drizzle-orm"
import {assertGenerationCredit, recordGenerationCharge} from './accountBilling'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {assertPersonPhotoCapacity, lockOwnedPerson} from './peopleRepository'
import {createError} from 'h3'
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

export type GenerationOwner = { organizationId: string; userId: string; authVersion?: number }

type PendingGeneration = {
    prompt: string
    inputImages: string[]
    modelImages: string[]
    requestedModel: string
    effectiveModel: string
    batchId: string
    parentSystemPromptId?: number
    personId?: string
    pipelineStepId?: string
    pipelineTextConfig?: NonNullable<typeof systemPrompt.$inferSelect.pipelineTextConfig>
    generationConfig: StoredGenerationConfig | null
}

type GenerationLog = Omit<NewAiGatewayLog, 'id' | 'systemPromptId' | 'createdAt'>

function normalizedTimestamps<T extends {createdAt: string; updatedAt?: string; outputImageDeletedAt?: string | null}>(row: T): T {
    return {
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
        ...(row.updatedAt ? {updatedAt: new Date(row.updatedAt).toISOString()} : {}),
        ...(row.outputImageDeletedAt ? {outputImageDeletedAt: new Date(row.outputImageDeletedAt).toISOString()} : {}),
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

// API callers must provide an authenticated owner. The unscoped form is for
// explicit maintenance/import tools and disposable database tests only.
export async function useDB(db = getDatabase(), owner?: GenerationOwner) {
    const generationScope = () => owner ? and(
        eq(systemPrompt.organizationId, owner.organizationId),
        eq(systemPrompt.userId, owner.userId),
    ) : undefined
    const logScope = () => owner ? and(
        eq(aiGatewayLog.organizationId, owner.organizationId),
        eq(aiGatewayLog.userId, owner.userId),
    ) : undefined
    const ownershipValues = () => owner ? {
        organizationId: owner.organizationId, userId: owner.userId,
    } : {}
    async function rowById(id: number) {
        const [row] = await db.select().from(systemPrompt).where(and(eq(systemPrompt.id, id), generationScope())).limit(1)
        return row ? normalizedTimestamps(row) : undefined
    }

    async function requiredRowById(id: number) {
        const row = await rowById(id)
        if (!row) throw new Error(`Generation row ${id} was not found after persistence`)
        return row
    }

    function pendingValues(data: PendingGeneration) {
        return {
            ...ownershipValues(),
            TextPrompt: data.prompt,
            serverImages: data.inputImages,
            modelImages: data.modelImages,
            outputImage: '',
            generationModel: data.effectiveModel,
            status: 'pending' as const,
            billingState: 'pending' as const,
            batchId: data.batchId,
            parentSystemPromptId: data.parentSystemPromptId ?? null,
            personId: data.personId ?? null,
            pipelineStepId: data.pipelineStepId ?? null,
            pipelineTextConfig: data.pipelineTextConfig ?? null,
            generationConfig: data.generationConfig,
            errors: null,
            errorJson: null,
        }
    }

    async function createPendingGenerations(items: PendingGeneration[]) {
        if (items.length === 0) return []
        if (owner) {
            for (const id of new Set(items.map(item => item.parentSystemPromptId).filter((id): id is number => id !== undefined))) {
                if (!await rowById(id)) throw new Error('Generation parent is unavailable to this account')
            }
        }
        // A single INSERT commits all pending output rows atomically and returns
        // PostgreSQL generated IDs without connection-local SQLite state.
        const rows = await db.transaction(async tx => {
            if (owner) {
                if (new Set(items.map(item => item.batchId)).size !== 1) throw new Error('Pending generations must share one batch')
                await assertGenerationCredit(tx, owner, items[0]!.batchId)
            }
            const pipelineStepIds = [...new Set(items.map(item => item.pipelineStepId).filter((id): id is string => id !== undefined))].sort()
            if (pipelineStepIds.length && !owner) throw createError({statusCode: 400, statusMessage: 'Pipeline generations require an authenticated account'})
            for (const stepId of pipelineStepIds) {
                const [step] = await tx.select().from(pipelineRunSteps).where(and(eq(pipelineRunSteps.id, stepId),
                    eq(pipelineRunSteps.organizationId, owner!.organizationId), eq(pipelineRunSteps.userId, owner!.userId))).for('update').limit(1)
                if (!step) throw createError({statusCode: 404, statusMessage: 'Pipeline step not found'})
                const [existingBatch] = await tx.select({id: systemPrompt.id}).from(systemPrompt).where(and(eq(systemPrompt.batchId, items[0]!.batchId),
                    eq(systemPrompt.pipelineStepId, stepId), eq(systemPrompt.organizationId, owner!.organizationId), eq(systemPrompt.userId, owner!.userId))).limit(1)
                // Additional already-paid provider outputs must be preserved
                // even if cancellation or lease recovery overtook publication.
                if (!existingBatch && (!step.active || step.status !== 'running' || !step.leaseExpiresAt || new Date(step.leaseExpiresAt).getTime() <= Date.now())) {
                    throw createError({statusCode: 409, statusMessage: 'Pipeline step execution is no longer active'})
                }
                if (!existingBatch) await tx.update(pipelineRunSteps).set({batchId: items[0]!.batchId, updatedAt: drizzleSql`CURRENT_TIMESTAMP`}).where(eq(pipelineRunSteps.id, stepId))
            }
            const personIds = [...new Set(items.map(item => item.personId).filter((id): id is string => id !== undefined))].sort()
            if (personIds.length && !owner) throw createError({statusCode: 400, statusMessage: 'People generations require an authenticated account'})
            const removedPeople = new Set<string>()
            for (const personId of personIds) {
                const [existingBatch] = await tx.select({id: systemPrompt.id}).from(systemPrompt)
                    .where(and(eq(systemPrompt.batchId, items[0]!.batchId), eq(systemPrompt.organizationId, owner!.organizationId), eq(systemPrompt.userId, owner!.userId))).limit(1)
                try {await lockOwnedPerson(tx, owner!, personId)} catch (error) {
                    // The profile may have been removed after a paid call
                    // began. Preserve extra paid outputs without that link.
                    if (existingBatch && (error as {statusCode?: number})?.statusCode === 404) {removedPeople.add(personId); continue}
                    throw error
                }
                // Persist extra paid provider outputs even if they exceed the
                // initial reservation. New batches still enforce the cap.
                if (!existingBatch) await assertPersonPhotoCapacity(tx, owner!, personId, items.filter(item => item.personId === personId).length)
            }
            const inserted = await tx.insert(systemPrompt).values(items.map(item => pendingValues(item.personId && removedPeople.has(item.personId)
                ? {...item, personId: undefined} : item))).returning()
            for (const row of inserted) await recordGenerationCharge(tx, row)
            return inserted
        })
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
                billingState: hasConfirmedGenerationPrice(data.billing) ? 'confirmed' : 'awaiting',
                updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
            }).where(and(
                eq(systemPrompt.id, id),
                eq(systemPrompt.status, 'pending'),
                generationScope(),
            )).returning()

            if (!row) return undefined
            await recordGenerationCharge(tx, row)

            await tx.insert(aiGatewayLog).values({
                ...data.log,
                organizationId: row.organizationId,
                userId: row.userId,
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
            releaseCharge?: boolean
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
                billingState: hasConfirmedGenerationPrice(billing) ? 'confirmed' : data.releaseCharge ? 'released' : 'awaiting',
                updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
            }).where(and(
                eq(systemPrompt.id, id),
                eq(systemPrompt.status, 'pending'),
                generationScope(),
            )).returning()

            if (!row) return undefined
            await recordGenerationCharge(tx, row, {release: data.releaseCharge})

            await tx.insert(aiGatewayLog).values({
                ...data.log,
                organizationId: row.organizationId,
                userId: row.userId,
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

    async function getExpiredGeneratedImagePaths(paths: readonly string[]) {
        if (!paths.length) return []
        if (paths.length > 200) throw new Error('Too many generated image paths to check')
        const rows = await db.selectDistinct({outputImage: systemPrompt.outputImage}).from(systemPrompt).where(and(
            inArray(systemPrompt.outputImage, [...new Set(paths)]),
            isNotNull(systemPrompt.outputImageDeletedAt),
            generationScope(),
        ))
        return [...new Set(rows.map(row => row.outputImage))]
    }

    async function updateSystemPromptBilling(id: number, billing: GenerationBilling) {
        return db.transaction(async tx => {
            const [prior] = await tx.select().from(systemPrompt).where(and(eq(systemPrompt.id, id), generationScope())).for('update').limit(1)
            if (!prior) return undefined
            if (hasConfirmedGenerationPrice(prior)) {
                if (prior.billingState === null) {
                    const [registered] = await tx.update(systemPrompt).set({billingState: 'confirmed'}).where(eq(systemPrompt.id, id)).returning()
                    if (registered) await recordGenerationCharge(tx, registered, {skipDebit: true})
                    return registered ? normalizedTimestamps(registered) : normalizedTimestamps(prior)
                }
                return normalizedTimestamps(prior)
            }
            const values = {...billingValues(billing),
                generationModel: billing.model ?? prior.generationModel,
                gatewayGenerationId: billing.gatewayGenerationId ?? prior.gatewayGenerationId,
                usageJson: {...(prior.usageJson ?? {}), ...(billing.usageJson ?? {})},
                billingState: hasConfirmedGenerationPrice(billing) ? 'confirmed' as const : prior.status === 'pending' ? 'pending' as const : 'awaiting' as const,
                updatedAt: drizzleSql`CURRENT_TIMESTAMP`}
            const [row] = await tx.update(systemPrompt).set(values).where(and(eq(systemPrompt.id, id), generationScope())).returning()
            if (row) await recordGenerationCharge(tx, row)
            return row ? normalizedTimestamps(row) : undefined
        })
    }

    async function touchPendingGenerations(ids: number[]) {
        if (!ids.length) return 0
        const rows = await db.update(systemPrompt).set({
            updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
        }).where(and(
            inArray(systemPrompt.id, ids),
            eq(systemPrompt.status, 'pending'),
            generationScope(),
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
            outputImageDeletedAt: systemPrompt.outputImageDeletedAt,
            generationModel: systemPrompt.generationModel,
            inputTokens: systemPrompt.inputTokens,
            outputTokens: systemPrompt.outputTokens,
            totalTokens: systemPrompt.totalTokens,
            cachedInputTokens: systemPrompt.cachedInputTokens,
            reasoningTokens: systemPrompt.reasoningTokens,
            priceUsd: systemPrompt.priceUsd,
            priceSource: drizzleSql<string | null>`CASE WHEN ${systemPrompt.usageJson}->'gatewayBilling'->>'isByok' = 'true' THEN 'unknown' ELSE ${systemPrompt.priceSource} END`,
            billingState: systemPrompt.billingState,
            gatewayGenerationId: systemPrompt.gatewayGenerationId,
            createdAt: systemPrompt.createdAt,
            updatedAt: systemPrompt.updatedAt,
            errors: systemPrompt.errors,
            status: systemPrompt.status,
            batchId: systemPrompt.batchId,
            parentSystemPromptId: systemPrompt.parentSystemPromptId,
            generationConfig: systemPrompt.generationConfig,
        }).from(systemPrompt)
            .where(and(generationScope(), drizzleSql`${systemPrompt.pipelineTextConfig} IS NULL`))
            .orderBy(desc(systemPrompt.createdAt), desc(systemPrompt.id))
            .limit(limit)
            .offset(offset)
        return rows.map(normalizedTimestamps)
    }

    async function countSystemPrompts() {
        const [result] = await db.select({value: drizzleSql<number>`count(*)`}).from(systemPrompt).where(and(generationScope(), drizzleSql`${systemPrompt.pipelineTextConfig} IS NULL`))
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
            organizationId: systemPrompt.organizationId,
            userId: systemPrompt.userId,
        }).from(systemPrompt).where(and(
            eq(systemPrompt.status, 'pending'),
            lt(systemPrompt.updatedAt, cutoff),
            noLiveLease,
            generationScope(),
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
                    billingState: 'awaiting',
                    updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
                }).where(and(
                    eq(systemPrompt.id, row.id),
                    eq(systemPrompt.status, 'pending'),
                    lt(systemPrompt.updatedAt, cutoff),
                    noLiveLease,
                    generationScope(),
                )).returning()
                if (rows.length === 0) continue
                await recordGenerationCharge(tx, rows[0]!)
                reconciled += 1
                await tx.insert(aiGatewayLog).values({
                    systemPromptId: row.id,
                    organizationId: row.organizationId,
                    userId: row.userId,
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
        const [row] = await db.insert(aiGatewayLog).values({...data, ...ownershipValues()}).returning()
        if (!row) throw new Error('Database did not return the Gateway log')
        return normalizedTimestamps(row)
    }

    async function getAiGatewayLogs(limit = 50) {
        const rows = await db.select().from(aiGatewayLog)
            .where(logScope())
            .orderBy(desc(aiGatewayLog.createdAt), desc(aiGatewayLog.id))
            .limit(Math.max(1, Math.min(200, limit)))
        return rows.map(normalizedTimestamps)
    }

    async function getGenerationBillingVisibility(ids: number[]) {
        if (ids.length > 200) throw new Error('Too many generation visibility checks')
        if (!ids.length) return []
        return db.select({id: systemPrompt.id, priceUsd: systemPrompt.priceUsd, priceSource: systemPrompt.priceSource,
            billingState: systemPrompt.billingState,
            usageJson: drizzleSql<{gatewayBilling: {isByok: unknown}}>`jsonb_build_object('gatewayBilling', jsonb_build_object('isByok', ${systemPrompt.usageJson}->'gatewayBilling'->'isByok'))`}).from(systemPrompt)
            .where(and(inArray(systemPrompt.id, ids), generationScope()))
    }

    return {
        createPendingGeneration,
        createPendingGenerations,
        completeGeneration,
        failGeneration,
        getSystemPrompt,
        getExpiredGeneratedImagePaths,
        updateSystemPromptBilling,
        getSystemPrompts,
        countSystemPrompts,
        touchPendingGenerations,
        reconcileStalePendingGenerations,
        createAiGatewayLog,
        getAiGatewayLogs,
        getGenerationBillingVisibility,
    }
}
