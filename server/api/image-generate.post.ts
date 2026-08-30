import { randomUUID } from 'node:crypto'
import {
    ImageGenerationRequestSchema,
    ImageModelIdSchema,
    canonicalizeImageModelId,
    createDefaultSettings,
    getImageModelProfile,
    type ImageGenerationRequest,
    type ImageGenerationSettings,
    type OutputMetadata,
    type StoredGenerationConfig,
    type StoredGenerationError,
} from '~~/schemas/image-generation'
import { useDB, type GenerationBilling } from '~~/server/utils/useDB'
import { useGateway } from '~~/server/utils/useGateway'
import {
    GenerationQueueFullError,
    getGenerationLimiter,
    getGenerationRuntimeSettings,
    unresolvedGenerationIndexes,
} from '~~/server/utils/generationLimiter'
import {installBoundedRawBody} from '~~/server/utils/boundedRequestBody'
import { allocateGenerationBilling } from '~~/server/utils/generationBilling'
import { sanitizeProviderMetadata } from '~~/server/utils/gatewayMetadata'
import { validateGptImageMaskPair } from '~~/server/utils/gptImageMask'

type RawBody = Record<string, unknown>
const MAX_GENERATION_REQUEST_BYTES = 512 * 1024
const EMPTY_GENERATED_IMAGE_BUFFER = Buffer.alloc(0)

function translateLegacySettings(
    model: ImageGenerationRequest['model'],
    raw: RawBody,
): ImageGenerationSettings {
    if (raw.settings) return raw.settings as ImageGenerationSettings
    const defaults = createDefaultSettings(model)
    const legacy = raw.imageConfig && typeof raw.imageConfig === 'object'
        ? raw.imageConfig as Record<string, unknown>
        : {}
    if (defaults.kind === 'openai-gpt-image-2') {
        return {
            ...defaults,
            ...(typeof legacy.size === 'string' ? {size: legacy.size} : {}),
        }
    }
    return {
        ...defaults,
        ...(typeof legacy.aspectRatio === 'string' ? {aspectRatio: legacy.aspectRatio} : {}),
        ...('imageSize' in defaults && typeof legacy.imageSize === 'string'
            ? {imageSize: legacy.imageSize}
            : {}),
    } as ImageGenerationSettings
}

function parseRequest(raw: RawBody) {
    const requestedModel = typeof raw.model === 'string' ? raw.model : undefined
    const canonicalModel = canonicalizeImageModelId(requestedModel)
    const parsedModel = ImageModelIdSchema.safeParse(canonicalModel)
    if (!parsedModel.success) {
        throw createError({
            statusCode: 400,
            statusMessage: `Unsupported image model '${canonicalModel}'. Choose one of the curated OpenAI or Gemini models.`,
        })
    }
    const candidate = {
        prompt: raw.prompt,
        model: parsedModel.data,
        inputImages: raw.inputImages ?? [],
        modelImages: raw.modelImages ?? [],
        maskImage: raw.maskImage,
        storeInputImages: raw.storeInputImages ?? true,
        parentSystemPromptId: raw.parentSystemPromptId,
        settings: translateLegacySettings(parsedModel.data, raw),
    }
    const parsed = ImageGenerationRequestSchema.safeParse(candidate)
    if (!parsed.success) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Invalid image generation request',
            data: {issues: parsed.error.issues},
        })
    }
    return {
        request: parsed.data,
        requestedModel: requestedModel ?? parsed.data.model,
    }
}

function errorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        const value = error as Record<string, any>
        return String(value.statusMessage || value.message || value.data?.reason || 'Image generation failed').slice(0, 4000)
    }
    return String(error || 'Image generation failed').slice(0, 4000)
}

function sanitizePublicErrorText(value: unknown): string {
    return String(value || 'Image generation failed')
        .replace(/[A-Za-z]:\\[^\r\n]*/g, '[internal path]')
        .replace(/\/(?:Users|home|var|tmp|app|workspace|data)\/[^\r\n]*/g, '[internal path]')
        .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, '[redacted image data]')
        .slice(0, 4000)
}

function persistenceDiagnostic(
    error: unknown,
    operation: string,
    statusMessage = 'Image generation storage is temporarily unavailable.',
) {
    const diagnosticId = randomUUID()
    console.error(`[image-generation:${diagnosticId}] ${operation}`, error)
    return createError({
        statusCode: 500,
        statusMessage,
        data: {
            code: 'GENERATION_PERSISTENCE_FAILED',
            retryable: true,
            diagnosticId,
        },
    })
}

function normalizeError(error: unknown): StoredGenerationError {
    const value = error && typeof error === 'object' ? error as Record<string, any> : {}
    const source = value.data && typeof value.data === 'object' ? value.data as Record<string, any> : value
    const statusCode = typeof source.statusCode === 'number'
        ? source.statusCode
        : typeof value.statusCode === 'number'
            ? value.statusCode
            : typeof source.status === 'number'
                ? source.status
            : undefined
    const requestId = [
        source.requestId,
        source.request_id,
        value.requestId,
        value.response?.headers?.get?.('x-request-id'),
    ].find(item => typeof item === 'string' && item.length > 0)
    const details: Record<string, unknown> = {}
    for (const key of ['reason', 'type', 'param', 'provider', 'finishReason', 'diagnosticId']) {
        const detail = source[key] ?? value[key]
        if (typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean') {
            details[key] = typeof detail === 'string' ? sanitizePublicErrorText(detail) : detail
        }
    }
    if (source.details != null) details.provider = sanitizeProviderMetadata(source.details, 8 * 1024)
    const rawMessage = typeof source.message === 'string' ? source.message : errorMessage(error)
    return {
        name: typeof source.name === 'string' ? source.name : (typeof value.name === 'string' ? value.name : undefined),
        message: sanitizePublicErrorText(rawMessage),
        statusCode,
        code: typeof source.code === 'string' ? source.code : (typeof value.code === 'string' ? value.code : undefined),
        retryable: typeof source.retryable === 'boolean'
            ? source.retryable
            : statusCode === 429 || (statusCode != null && statusCode >= 500),
        requestId: requestId as string | undefined,
        details: Object.keys(details).length ? details : undefined,
    }
}

export default defineEventHandler(async (event) => {
    useAuth(event)
    await installBoundedRawBody(event, MAX_GENERATION_REQUEST_BYTES)
    const raw = await readBody<RawBody>(event)
    const {request, requestedModel} = parseRequest(raw ?? {})
    const profile = getImageModelProfile(request.model)
    if (!profile) {
        throw createError({statusCode: 400, statusMessage: `No profile exists for ${request.model}`})
    }

    const runtimeConfig = useRuntimeConfig()
    const generationRuntime = getGenerationRuntimeSettings(
        runtimeConfig as unknown as Record<string, unknown>,
    )
    const limiter = getGenerationLimiter(
        generationRuntime.concurrency,
        generationRuntime.maxQueue,
    )
    const database = await useDB()
    try {
        await database.reconcileStalePendingGenerations(generationRuntime.staleTtlMs)
    } catch (error) {
        throw persistenceDiagnostic(error, 'Could not reconcile stale generation rows')
    }
    const imageFs = await useFS()
    const batchId = randomUUID()
    const expectedOutputs = request.settings.kind === 'openai-gpt-image-2'
        ? request.settings.numberOfImages
        : 1
    const sourceImages: Array<string | null> = request.inputImages.length
        ? request.inputImages
        : [null]
    const generationConfig: StoredGenerationConfig = {
        schemaVersion: 1,
        profileVersion: profile.profileVersion,
        requestedModel,
        effectiveModel: request.model,
        settings: request.settings,
        maskImage: request.maskImage,
        storeInputImages: request.storeInputImages,
    }

    function pendingRowData(inputImage: string | null) {
        const storedInputs = request.storeInputImages && inputImage ? [inputImage] : []
        return {
            prompt: request.prompt,
            inputImages: storedInputs,
            modelImages: request.modelImages,
            requestedModel,
            effectiveModel: request.model,
            batchId,
            parentSystemPromptId: request.parentSystemPromptId,
            generationConfig,
        }
    }

    async function createPendingRow(inputImage: string | null) {
        return database.createPendingGeneration(pendingRowData(inputImage))
    }

    async function preflightMaskSources() {
        if (!request.maskImage) return
        const mask = await imageFs.getImageFile(request.maskImage)
        const maskDescriptor = {
            mimeType: mask.mimeType,
            bytes: mask.buffer.length,
            width: mask.width,
            height: mask.height,
            hasAlpha: mask.hasAlpha,
        }
        for (const inputImage of sourceImages) {
            const firstSource = inputImage ?? request.modelImages[0]
            const source = firstSource ? await imageFs.getImageFile(firstSource) : undefined
            const validationError = validateGptImageMaskPair(maskDescriptor, source ? {
                mimeType: source.mimeType,
                bytes: source.buffer.length,
                width: source.width,
                height: source.height,
                hasAlpha: source.hasAlpha,
            } : undefined)
            if (validationError) {
                throw createError({statusCode: 400, statusMessage: validationError})
            }
        }
    }

    // Validate the mask against every per-job source before creating any
    // pending rows. One bad later source rejects the request atomically.
    await preflightMaskSources()
    const gateway = await useGateway()

    const jobs: Array<{
        inputImage: string | null
        rows: Array<NonNullable<Awaited<ReturnType<typeof database.createPendingGeneration>>>>
    }> = []
    let initialRows: Awaited<ReturnType<typeof database.createPendingGenerations>>
    try {
        initialRows = await database.createPendingGenerations(sourceImages.flatMap(inputImage =>
            Array.from({length: expectedOutputs}, () => pendingRowData(inputImage)),
        ))
    } catch (error) {
        throw persistenceDiagnostic(error, `Could not create pending rows for batch ${batchId}`)
    }
    let initialRowIndex = 0
    for (const inputImage of sourceImages) {
        const rows = initialRows.slice(initialRowIndex, initialRowIndex + expectedOutputs)
        initialRowIndex += expectedOutputs
        jobs.push({inputImage, rows})
    }

    function baseLog(job: typeof jobs[number], startedAt: number) {
        return {
            batchId,
            attemptNumber: 1,
            model: request.model,
            prompt: request.prompt,
            inputImages: job.inputImage ? [job.inputImage] : [],
            modelImages: request.modelImages,
            requestJson: {
                batchId,
                model: request.model,
                prompt: request.prompt,
                inputImages: job.inputImage ? [job.inputImage] : [],
                modelImages: request.modelImages,
                maskImage: request.maskImage,
                settings: request.settings,
            },
            resolvedConfigJson: generationConfig,
            durationMs: Date.now() - startedAt,
        }
    }

    async function persistFailure(
        job: typeof jobs[number],
        rowIndex: number,
        error: unknown,
        startedAt: number,
        billing: GenerationBilling = {model: request.model},
    ) {
        const normalized = normalizeError(error)
        const row = job.rows[rowIndex]
        if (!row) throw new Error(`Missing pending row at output index ${rowIndex}`)
        return database.failGeneration(row.id, {
            error: normalized,
            billing,
            log: {
                ...baseLog(job, startedAt),
                status: 'error',
                outputImage: null,
                outputMimeType: null,
                inputTokens: billing.inputTokens ?? null,
                outputTokens: billing.outputTokens ?? null,
                totalTokens: billing.totalTokens ?? null,
                priceUsd: billing.priceUsd ?? null,
                priceSource: billing.priceSource ?? null,
                gatewayGenerationId: billing.gatewayGenerationId ?? null,
                providerRequestId: normalized.requestId ?? null,
                responseJson: {reason: normalized.message},
                error: normalized.message,
                errorJson: normalized,
            },
        })
    }

    async function runJob(job: typeof jobs[number]) {
        const startedAt = Date.now()
        const terminalIndexes = new Set<number>()
        const savedOutputUrls = new Map<number, string>()
        const rows: Array<NonNullable<Awaited<ReturnType<typeof database.getSystemPrompt>>>> = []
        let generated: Array<Awaited<ReturnType<typeof gateway.generateAnyImage>>[number] | undefined> = []

        function rememberRow(index: number, row: NonNullable<Awaited<ReturnType<typeof database.getSystemPrompt>>>) {
            terminalIndexes.add(index)
            const existing = rows.findIndex(item => item.id === row.id)
            if (existing >= 0) rows[existing] = row
            else rows.push(row)
        }

        try {
            generated = await gateway.generateAnyImage({
                ...request,
                inputImages: job.inputImage ? [job.inputImage] : [],
            })
            const generatedCount = generated.length
            // Gemini may return more than one image even though its API has no
            // deterministic `n` option. Persist every charged output.
            while (job.rows.length < generatedCount) {
                job.rows.push(await createPendingRow(job.inputImage))
            }
            for (let outputIndex = 0; outputIndex < job.rows.length; outputIndex += 1) {
                const image = generated[outputIndex]
                if (!image) {
                    const failure = await persistFailure(
                        job,
                        outputIndex,
                        createError({
                            statusCode: 502,
                            statusMessage: `Provider returned ${generatedCount} of ${job.rows.length} requested images.`,
                        }),
                        startedAt,
                    )
                    rememberRow(outputIndex, failure.row)
                    continue
                }

                try {
                    const billing = allocateGenerationBilling(image.billing ?? {model: request.model}, outputIndex, generatedCount)
                    const pendingRow = job.rows[outputIndex]
                    if (!pendingRow) throw new Error(`Missing pending row at output index ${outputIndex}`)
                    let saved: Awaited<ReturnType<typeof imageFs.saveGeneratedImage>> | undefined
                    try {
                        saved = await imageFs.saveGeneratedImage(image.buffer, image.mimeType)
                        savedOutputUrls.set(outputIndex, saved.url)
                        const outputMetadata: OutputMetadata = {
                            mimeType: saved.mimeType,
                            bytes: saved.bytes,
                            width: saved.width,
                            height: saved.height,
                            responseText: image.responseText || undefined,
                            reasoningText: image.reasoningText || undefined,
                            warnings: Array.isArray(image.warnings) ? image.warnings : [],
                            grounding: image.grounding,
                        }
                        const completion = await database.completeGeneration(pendingRow.id, {
                            outputImage: saved.url,
                            outputMetadata,
                            billing,
                            log: {
                                ...baseLog(job, startedAt),
                                status: 'success',
                                outputImage: saved.url,
                                outputMimeType: saved.mimeType,
                                inputTokens: billing.inputTokens ?? null,
                                outputTokens: billing.outputTokens ?? null,
                                totalTokens: billing.totalTokens ?? null,
                                priceUsd: billing.priceUsd ?? null,
                                priceSource: billing.priceSource ?? null,
                                gatewayGenerationId: billing.gatewayGenerationId ?? null,
                                responseJson: {outputMetadata, billing},
                                error: null,
                                errorJson: null,
                            },
                        })
                        // A stale-job reconciler may have won the conditional
                        // transition. In that case this newly written file was
                        // never linked and must be removed.
                        if (!completion.transitioned) {
                            await imageFs.removeGeneratedImage(saved.url).catch(() => undefined)
                            savedOutputUrls.delete(outputIndex)
                        }
                        rememberRow(outputIndex, completion.row)
                    } catch (persistenceError) {
                        const publicError = persistenceDiagnostic(
                            persistenceError,
                            `Could not durably persist output ${outputIndex} for row ${pendingRow.id}`,
                            'Generated image persistence failed.',
                        )
                        // A failed transaction response can be an ambiguous commit.
                        // Never unlink the output unless a subsequent DB read proves
                        // that the row is not succeeded.
                        let current: Awaited<ReturnType<typeof database.getSystemPrompt>>
                        let stateKnown = true
                        try {
                            current = await database.getSystemPrompt(pendingRow.id)
                        } catch (stateError) {
                            stateKnown = false
                            console.error('[image-generation] Could not resolve ambiguous persistence state', {
                                diagnosticId: publicError.data?.diagnosticId,
                                rowId: pendingRow.id,
                                error: stateError,
                            })
                        }
                        if (current?.status === 'succeeded') {
                            rememberRow(outputIndex, current)
                            continue
                        }
                        if (!stateKnown) throw publicError
                        if (saved?.url) {
                            await imageFs.removeGeneratedImage(saved.url).catch(() => undefined)
                            savedOutputUrls.delete(outputIndex)
                        }
                        const failure = await persistFailure(job, outputIndex, publicError, startedAt, billing)
                        rememberRow(outputIndex, failure.row)
                    }
                } finally {
                    // Drop both references immediately. The image bytes are no
                    // longer needed once persistence/repair has taken over.
                    image.buffer = EMPTY_GENERATED_IMAGE_BUFFER
                    generated[outputIndex] = undefined
                }
            }
            return rows
        } catch (generationError) {
            const repairErrors: unknown[] = []
            for (const outputIndex of unresolvedGenerationIndexes(job.rows.length, terminalIndexes)) {
                try {
                    const failure = await persistFailure(job, outputIndex, generationError, startedAt)
                    const savedUrl = savedOutputUrls.get(outputIndex)
                    if (failure.row.status !== 'succeeded' && savedUrl) {
                        await imageFs.removeGeneratedImage(savedUrl).catch(() => undefined)
                        savedOutputUrls.delete(outputIndex)
                    }
                    rememberRow(outputIndex, failure.row)
                } catch (repairError) {
                    const pendingRow = job.rows[outputIndex]
                    const current = pendingRow
                        ? await database.getSystemPrompt(pendingRow.id).catch(() => undefined)
                        : undefined
                    if (current && current.status !== 'pending') {
                        rememberRow(outputIndex, current)
                    } else {
                        repairErrors.push(repairError)
                    }
                }
            }
            if (repairErrors.length) {
                throw new AggregateError(repairErrors, 'Failed to repair one or more pending generation rows')
            }
            return rows
        } finally {
            // If processing aborted mid-array, release every unvisited provider
            // output as well instead of retaining the full multi-image response.
            for (let index = 0; index < generated.length; index += 1) {
                const remaining = generated[index]
                if (!remaining) continue
                remaining.buffer = EMPTY_GENERATED_IMAGE_BUFFER
                generated[index] = undefined
            }
        }
    }

    // Pending rows act as leases. Heartbeats keep queued and running work from
    // being reclaimed by another worker; a dead process stops heartbeating and
    // its rows become eligible after the configured stale TTL.
    const heartbeat = setInterval(() => {
        const ids = jobs.flatMap(job => job.rows.map(row => row.id))
        void database.touchPendingGenerations(ids).catch(error => {
            console.error('[image-generation] Failed to refresh pending generation leases', error)
        })
    }, generationRuntime.heartbeatMs)
    heartbeat.unref?.()

    let settled: PromiseSettledResult<Awaited<ReturnType<typeof runJob>>>[]
    try {
        settled = await Promise.allSettled(jobs.map(job => limiter.run(() => runJob(job))))
    } finally {
        clearInterval(heartbeat)
    }

    const objects = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    const infrastructureFailures: Array<{
        result: PromiseRejectedResult
        job: typeof jobs[number]
    }> = []
    settled.forEach((result, index) => {
        const job = jobs[index]
        if (result.status === 'rejected' && job) infrastructureFailures.push({result, job})
    })

    for (const {result, job} of infrastructureFailures) {
        console.error('[image-generation] Generation job rejected; attempting terminal repair', result.reason)
        for (let outputIndex = 0; outputIndex < job.rows.length; outputIndex += 1) {
            try {
                const repaired = await persistFailure(job, outputIndex, result.reason, Date.now())
                if (!objects.some(row => row.id === repaired.row.id)) objects.push(repaired.row)
            } catch (repairError) {
                console.error('[image-generation] Failed to repair a pending generation row', repairError)
                const row = job.rows[outputIndex]
                    ? await database.getSystemPrompt(job.rows[outputIndex]!.id).catch(() => undefined)
                    : undefined
                if (row && !objects.some(item => item.id === row.id)) objects.push(row)
            }
        }
    }

    const allRejectedForOverload = infrastructureFailures.length === jobs.length
        && infrastructureFailures.every(({result}) => result.reason instanceof GenerationQueueFullError)
    if (allRejectedForOverload) {
        throw createError({
            statusCode: 429,
            statusMessage: 'Image generation queue is full. Please try again later.',
            data: {batchId},
        })
    }
    const succeeded = objects.filter(row => row?.status === 'succeeded').length
    const failed = objects.filter(row => row?.status === 'failed').length
    const pending = objects.filter(row => row?.status === 'pending').length
    return {
        ok: failed === 0 && pending === 0,
        obj: objects,
        batchId,
        summary: {
            requested: sourceImages.length * expectedOutputs,
            total: objects.length,
            succeeded,
            failed: failed + pending,
        },
    }
})
