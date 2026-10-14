import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {createError} from 'h3'
import {and, asc, eq, inArray, isNull, lte, sql} from 'drizzle-orm'
import {pipelineRuns, users, organizations} from '../db/schema'
import {getDatabase} from './lib/db'
import {PIPELINE_LIMITS, type PipelineNode, type PipelineValue, type PipelineImageValue} from '../../schemas/pipelines'
import {ImageGenerationRequestSchema, getImageModelProfile, type ImageGenerationRequest} from '../../schemas/image-generation'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {createPipelineRepository, emptyPipelineValue, safePipelineError, type PipelineActor} from './pipelineRepository'
import {runAccountImageGeneration} from './imageGenerationService'
import {useDB, type GenerationBilling} from './useDB'
import {useGateway} from './useGateway'
import {createAccountBilling} from './accountBilling'
import {reconcileAccountBilling} from './billingReconciliation'
import {extractGatewayErrorBilling} from './billingGatewayError'
import {reserveGenerationBatch, getGenerationRuntimeSettings, getGenerationRequestTimeoutMs} from './generationLimiter'
import {createBackgroundRemovalRepository} from './backgroundRemovalJobs'
import {kickBackgroundRemovalQueue} from './backgroundRemovalRunner'
import {wakePipelineWorker} from './pipelineWorkerWake'
import {getBackgroundRemovalModel} from '../../schemas/background-removal-models'
import {processLocalPipelineImage, prepareExpansionCanvas, type LocalPipelineImageOperation} from './pipelineImageProcessing'
import type {AuthContext} from './accountSession'
import type {CoordinationPool} from './databaseCoordination'

type Repository = ReturnType<typeof createPipelineRepository>
type Claim = NonNullable<Awaited<ReturnType<Repository['claim']>>>
type Storage = Awaited<ReturnType<Repository['storage']>>
type Gateway = Awaited<ReturnType<typeof useGateway>>
type Background = ReturnType<typeof createBackgroundRemovalRepository>
type Options = {
    generate?: typeof runAccountImageGeneration
    gateway?: Gateway
    processImage?: typeof processLocalPipelineImage
    prepareExpansion?: typeof prepareExpansionCanvas
    background?: Background
    kickBackground?: () => Promise<void>
    runtimeConfig?: Record<string, unknown>
    backgroundWaitMs?: number
    signal?: AbortSignal
    coordinationPool?: CoordinationPool
    generationDatabase?: Awaited<ReturnType<typeof useDB>>
}

const joinText = (...values: Array<string | null | undefined>) => values.filter(value => value?.trim()).join('\n').trim()
function invalid(message: string): never {throw createError({statusCode: 400, statusMessage: message})}
/** Resolve typed ports from the immutable graph, preserving connection order. */
export function resolvePipelineInputs(claim: Claim): Record<string, PipelineValue> {
    const result: Record<string, PipelineValue> = {}
    for (const edge of claim.run.definition.edges.filter(value => value.target === claim.node.id)) {
        const source = claim.dependencies.find(step => step.nodeId === edge.source)
        if (!source?.value || source.status !== 'succeeded') invalid('A pipeline dependency is unavailable')
        const existing = result[edge.targetPort] ??= emptyPipelineValue()
        if (edge.sourcePort === 'image') existing.images.push(...source.value.images)
        else existing.text = joinText(existing.text, source.value.text)
    }
    for (const value of Object.values(result)) if (value.images.length > PIPELINE_LIMITS.imagesPerStep) invalid('Too many connected images')
    return result
}

/** One awaited, fenced unit works from HTTP or a separately managed worker. */
export function createPipelineExecutor(actor: PipelineActor, repository = createPipelineRepository(actor), options: Options = {}) {
    const runtimeConfig = () => options.runtimeConfig ?? useRuntimeConfig() as unknown as Record<string, unknown>
    let gatewayPromise: Promise<Gateway> | undefined
    const gateway = async (storage: Storage) => gatewayPromise ??= options.gateway ? Promise.resolve(options.gateway) : useGateway(storage)
    async function priceRefresh(storage: Storage) {
        try {
            const ledger = createAccountBilling(repository.db)
            await reconcileAccountBilling(actor, ledger, {getGenerationBilling: async id => (await gateway(storage)).getGenerationBilling(id)}, {limit: 2, lookupTimeoutMs: 5000})
        } catch { /* Keep all unconfirmed media held when Gateway billing is unavailable. */ }
    }
    async function reauthorize(claim: Claim, storage: Storage, inputs: Record<string, PipelineValue>) {
        const paths = Object.values(inputs).flatMap(value => value.images.map(image => image.url))
        const node = claim.node
        if (node.type === 'static-image' || node.type === 'people-input') paths.push(...node.config.images)
        if (node.type === 'image-input') {
            const url = node.id === claim.run.batchInputNodeId ? claim.item.inputUrl : claim.run.inputs[node.id] || node.config.defaultImage
            if (url) paths.push(url)
        }
        if (node.type === 'generate-image') paths.push(...node.config.referenceImages, ...(node.config.maskImage ? [node.config.maskImage] : []))
        // General asset access may survive an independent file share. People
        // sources still require a live photo association and profile grant,
        // even after an intermediate image has become owned by this runner.
        await repository.assertPeopleNodeSources(claim.run.definition, node.id)
        await storage.assertReadableImages([...new Set(paths)])
    }
    async function imageValues(urls: string[]) {
        return Promise.all([...new Set(urls)].map(url => repository.imageValue(url)))
    }
    async function stageLocal(claim: Claim, sources: PipelineImageValue[], operation: LocalPipelineImageOperation, storage: Storage, signal: AbortSignal, text: string | null = null) {
        const staged: Array<{source: PipelineImageValue; image: Awaited<ReturnType<Storage['prepareProcessedImage']>>}> = []
        let published = false
        try {
            for (const source of sources) {
                signal.throwIfAborted()
                const input = await storage.getImageFile(source.url)
                const output = await (options.processImage ?? processLocalPipelineImage)(input.buffer, operation, signal)
                input.buffer = Buffer.alloc(0)
                const image = await storage.prepareProcessedImage(output.buffer, {purpose: 'pipeline', mimeType: output.mimeType,
                    name: `${claim.node.label.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').slice(0, 120)}.${output.mimeType === 'image/jpeg' ? 'jpg' : output.mimeType === 'image/webp' ? 'webp' : 'png'}`})
                output.buffer = Buffer.alloc(0)
                staged.push({source, image})
            }
            const value: PipelineValue = {images: [], text}
            published = await repository.finish(claim.step.id, claim.token, 'succeeded', value, null, async tx => {
                for (const item of staged) {
                    const output = await item.image.register(tx, {id: item.source.id, url: item.source.url})
                    await repository.registerProcessed(tx, claim.step.id, output)
                    value.images.push({id: output.outputAssetId, url: output.outputUrl, name: `${claim.node.label} result`, priceUsd: '0', priceSource: 'local-processing'})
                }
            }, sources.map(source => source.url))
        } finally {
            if (!published) for (const item of staged) await item.image.discard().catch(() => console.error('An unregistered pipeline output could not be removed.'))
        }
    }
    async function preparedExpansion(claim: Claim, source: PipelineImageValue, storage: Storage, signal: AbortSignal) {
        if (claim.node.type !== 'expand') invalid('Invalid expansion node')
        const input = await storage.getImageFile(source.url)
        const prepared = await (options.prepareExpansion ?? prepareExpansionCanvas)(input.buffer, claim.node.config, signal)
        input.buffer = Buffer.alloc(0)
        const profile = getImageModelProfile(claim.node.config.model)!
        const canvas = await storage.prepareProcessedImage(prepared.buffer, {purpose: 'pipeline', name: 'Expansion canvas.png'})
        prepared.buffer = Buffer.alloc(0)
        let mask: Awaited<ReturnType<Storage['prepareProcessedImage']>> | undefined, published = false
        try {
            if (profile.supportsMask) mask = await storage.prepareProcessedImage(profile.maskMode === 'luminance' ? prepared.luminanceMaskBuffer : prepared.maskBuffer,
                {purpose: 'pipeline', name: 'Expansion mask.png'})
            prepared.maskBuffer = Buffer.alloc(0); prepared.luminanceMaskBuffer = Buffer.alloc(0)
            const registered = await repository.publishPreparation(claim.step.id, claim.token, async tx => {
                const image = await canvas.register(tx, {id: source.id, url: source.url})
                await repository.registerProcessed(tx, claim.step.id, image)
                const registeredMask = mask ? await mask.register(tx, {id: source.id, url: source.url}) : undefined
                if (registeredMask) await repository.registerProcessed(tx, claim.step.id, registeredMask)
                return {image, mask: registeredMask}
            }, [source.url])
            published = true
            return {url: registered.image.outputUrl, mask: registered.mask?.outputUrl, width: prepared.width, height: prepared.height, placement: prepared.placement}
        } finally {
            if (!published) {await canvas.discard().catch(() => undefined); await mask?.discard().catch(() => undefined)}
        }
    }
    async function generateImage(claim: Claim, inputs: Record<string, PipelineValue>, storage: Storage, signal: AbortSignal) {
        const node = claim.node
        if (!['generate-image', 'expand', 'translate', 'upscale'].includes(node.type) || !('settings' in node.config)) invalid('Invalid generation node')
        let sources = inputs.image?.images ?? []
        let prompt = '', maskImage: string | undefined, references: string[] = []
        if (node.type === 'generate-image') {
            prompt = joinText(node.config.prompt, inputs.prompt?.text)
            references = [...node.config.referenceImages, ...(inputs.references?.images ?? []).map(image => image.url)]
            maskImage = inputs.mask?.images[0]?.url ?? node.config.maskImage
        } else if (node.type === 'expand') {
            if (!sources.length) invalid('An Expand node needs a connected image')
            const previous = await repository.generationRows(claim.step.id)
            const sourceIndex = new Set(previous.map(row => row.batchId).filter(Boolean)).size
            const source = sources[sourceIndex]
            if (!source) invalid('Expansion input is no longer available')
            // Each source needs its own immutable canvas and mask. One awaited
            // wave is admitted at a time, with a fresh credit check after the
            // preceding wave's exact price is confirmed.
            const prepared = await preparedExpansion(claim, source, storage, signal)
            sources = [{...source, url: prepared.url}]
            maskImage = prepared.mask
            prompt = joinText(node.config.prompt, inputs.prompt?.text,
                `Fill the empty margins of this ${prepared.width} by ${prepared.height} pixel canvas naturally. Preserve the original subject in its existing position and scale. The original region begins at ${prepared.placement.left}, ${prepared.placement.top} and is ${prepared.placement.width} by ${prepared.placement.height}. Creativity: ${node.config.creativity}.`)
        } else if (node.type === 'translate') {
            prompt = joinText(`Translate all readable text in the image into ${node.config.language}. Preserve the design, composition, colors, and image subject.`, node.config.prompt, inputs.prompt?.text)
        } else if (node.type === 'upscale') {
            prompt = `Upscale this image by ${node.config.scale} times with natural fine detail. Preserve the original subject, identity, composition, proportions, and colors.`
        }
        references = [...new Set(references)]
        const candidate = ImageGenerationRequestSchema.safeParse({model: node.config.model, settings: node.config.settings, prompt,
            inputImages: sources.map(image => image.url), modelImages: references, maskImage, storeInputImages: true})
        if (!candidate.success) invalid('The connected images, prompt, mask, or settings exceed the selected model limits')
        signal.throwIfAborted()
        await (options.generate ?? runAccountImageGeneration)(actor as AuthContext, candidate.data!, {pipelineStepId: claim.step.id, runtimeConfig: runtimeConfig(), signal,
            beforeProviderCall: async context => {
                signal.throwIfAborted()
                // Original shared sources remain required even when a local
                // prepared canvas is now owned by the pipeline runner.
                await reauthorize(claim, storage, inputs)
                await repository.providerStarted(claim.step.id, claim.token, context.batchId)
                signal.throwIfAborted()
            }})
        await repository.finish(claim.step.id, claim.token, 'awaiting-price', null)
    }
    async function generateText(claim: Claim, inputs: Record<string, PipelineValue>, storage: Storage, signal: AbortSignal) {
        const node = claim.node
        if (node.type !== 'describe-image' && node.type !== 'prompt-enhancer' && node.type !== 'llm') invalid('Invalid text node')
        const imageUrls = (inputs.image?.images ?? []).map(image => image.url)
        const instruction = node.type === 'describe-image'
            ? 'Describe this image accurately for use in a product image generation prompt. Return only the useful description.'
            : node.type === 'prompt-enhancer' ? 'Improve the provided image generation prompt while preserving its intended subject and instructions. Return only the improved prompt.' : ''
        const prompt = joinText(instruction, node.config.prompt, inputs.prompt?.text, inputs.text?.text)
        if (!prompt || prompt.length > PIPELINE_LIMITS.textLength || imageUrls.length > 8) invalid('Text utility input exceeds its limits')
        const batchId = randomUUID(), config = runtimeConfig(), runtime = getGenerationRuntimeSettings(config)
        const reservation = await reserveGenerationBatch(batchId, 1, runtime, getGenerationRequestTimeoutMs(config), options.coordinationPool, signal)
        const database = options.generationDatabase ?? await useDB(repository.db, actor)
        let row: Awaited<ReturnType<typeof database.createPendingGeneration>> | undefined, providerStarted = false
        let providerBilling: GenerationBilling | undefined
        const startedAt = Date.now()
        const pipelineTextConfig = {...node.config, prompt, imageUrls}
        const logBase = {batchId, attemptNumber: claim.step.attempt, model: node.config.model, prompt, inputImages: imageUrls, modelImages: [],
            requestJson: pipelineTextConfig, resolvedConfigJson: null}
        try {
            await storage.assertReadableImages(imageUrls)
            row = await database.createPendingGeneration({prompt, inputImages: imageUrls, modelImages: [], requestedModel: node.config.model,
                effectiveModel: node.config.model, batchId, pipelineStepId: claim.step.id, pipelineTextConfig, generationConfig: null})
            await reservation.run(0, async requestSignal => {
                signal.throwIfAborted()
                const combined = AbortSignal.any([signal, requestSignal])
                const generated = await (await gateway(storage)).generatePipelineText({model: node.config.model, prompt, system: node.config.systemPrompt.trim() || undefined,
                    ...(node.config.temperature === undefined ? {} : {temperature: node.config.temperature}),
                    ...('reasoningEffort' in node.config ? {reasoningEffort: node.config.reasoningEffort} : {}),
                    maxOutputTokens: node.config.maxOutputTokens, imageUrls}, combined, async () => {
                    await reauthorize(claim, storage, inputs)
                    await repository.providerStarted(claim.step.id, claim.token, batchId)
                    combined.throwIfAborted(); providerStarted = true
                })
                providerBilling = generated.billing
                await database.completeGeneration(row!.id, {outputImage: '', outputMetadata: {mimeType: 'text/plain', bytes: Buffer.byteLength(generated.text),
                    responseText: generated.text, warnings: generated.warnings}, billing: generated.billing,
                    log: {...logBase, status: 'success', durationMs: Date.now() - startedAt, outputImage: null, outputMimeType: null,
                        priceUsd: generated.billing.priceUsd ?? null, priceSource: generated.billing.priceSource ?? null,
                        gatewayGenerationId: generated.billing.gatewayGenerationId ?? null, responseJson: {text: generated.text, warnings: generated.warnings, billing: generated.billing}}})
            })
            await repository.finish(claim.step.id, claim.token, 'awaiting-price', null)
        } catch (error) {
            if (row) {
                const current = await database.getSystemPrompt(row.id).catch(() => undefined)
                if (current?.status !== 'succeeded') {
                    const billing = extractGatewayErrorBilling(error) ?? providerBilling ?? {}, failure = safePipelineError(error)
                    await database.failGeneration(row.id, {error: failure, billing, releaseCharge: !providerStarted,
                        log: {...logBase, status: 'error', durationMs: Date.now() - startedAt, outputImage: null, outputMimeType: null,
                            priceUsd: billing.priceUsd ?? null, priceSource: billing.priceSource ?? null, gatewayGenerationId: billing.gatewayGenerationId ?? null,
                            error: failure.message, errorJson: failure, responseJson: {reason: failure.message}}})
                }
                await repository.finish(claim.step.id, claim.token, 'awaiting-price', null, current?.status === 'succeeded' ? null : safePipelineError(error))
            } else throw error
        } finally {await reservation.close()}
    }
    async function backgroundRemoval(claim: Claim, inputs: Record<string, PipelineValue>, storage: Storage, signal: AbortSignal) {
        if (claim.node.type !== 'remove-background') invalid('Invalid background removal node')
        const sources = inputs.image?.images ?? [], value = claim.step.value ?? emptyPipelineValue()
        if (!sources.length) invalid('Connect an image to Remove Background')
        const background = options.background ?? createBackgroundRemovalRepository(repository.db)
        const source = sources[value.images.length]
        if (!source) {await repository.finish(claim.step.id, claim.token, 'succeeded', value); return}
        let job = claim.step.backgroundRemovalJobId ? await background.get(actor, claim.step.backgroundRemovalJobId) : null
        if (!job) {
            const profile = getBackgroundRemovalModel(claim.node.config.model)
            job = await background.enqueue(actor, {sourceAssetId: source.id, sourceUrl: source.url, model: profile.id,
                modelVersion: profile.version, idempotencyKey: randomUUID(), pipelineStepId:claim.step.id, pipelineClaimToken:claim.token})
        }
        void (options.kickBackground ?? kickBackgroundRemovalQueue)()
        const until = Date.now() + Math.max(0, Math.min(120_000, options.backgroundWaitMs ?? 20_000))
        while (['queued', 'running'].includes(job.status) && Date.now() < until) {
            await delay(750, undefined, {signal}); job = await background.get(actor, job.id)
        }
        if (job.status === 'succeeded' && job.outputUrl) {
            value.images.push(await repository.imageValue(job.outputUrl))
            await repository.setBackgroundJob(claim.step.id, claim.token, null)
            await repository.finish(claim.step.id, claim.token, value.images.length === sources.length ? 'succeeded' : 'queued', value)
        } else if (job.status === 'failed' || job.status === 'cancelled') {
            await repository.finish(claim.step.id, claim.token, 'failed', value, job.error ?? {code: 'PROCESSING_FAILED', message: 'Background removal did not finish.', retryable: true})
        } else await repository.finish(claim.step.id, claim.token, 'queued', value)
    }
    async function execute(claim: Claim, storage: Storage, signal: AbortSignal) {
        const inputs = resolvePipelineInputs(claim), node = claim.node
        await reauthorize(claim, storage, inputs)
        signal.throwIfAborted()
        if (node.type === 'image-input') {
            const url = node.id === claim.run.batchInputNodeId ? claim.item.inputUrl : claim.run.inputs[node.id] || node.config.defaultImage
            if (!url && node.config.required) invalid('Choose a required image input')
            await repository.finish(claim.step.id, claim.token, 'succeeded', {images: url ? await imageValues([url]) : [], text: null}); return
        }
        if (node.type === 'text-input') {
            const text = claim.run.inputs[node.id] ?? node.config.defaultValue
            if (!text.trim() && node.config.required) invalid('Enter required text')
            await repository.finish(claim.step.id, claim.token, 'succeeded', {images: [], text}); return
        }
        if (node.type === 'static-image' || node.type === 'people-input') {await repository.finish(claim.step.id, claim.token, 'succeeded', {images: await imageValues(node.config.images), text: null}); return}
        if (node.type === 'static-text') {await repository.finish(claim.step.id, claim.token, 'succeeded', {images: [], text: node.config.text}); return}
        if (node.type === 'prompt-concatenator') {
            const texts = claim.run.definition.edges.filter(edge => edge.target === node.id && edge.sourcePort === 'text')
                .map(edge => claim.dependencies.find(step => step.nodeId === edge.source)?.value?.text ?? '')
            const text = texts.join(node.config.separator)
            if (!text.trim() || text.length > PIPELINE_LIMITS.textLength) invalid('Combined prompt exceeds its limits')
            await repository.finish(claim.step.id, claim.token, 'succeeded', {images: [], text}); return
        }
        if (node.type === 'generate-image' || node.type === 'expand' || node.type === 'translate' || node.type === 'upscale' && node.config.mode === 'ai') {
            await generateImage(claim, inputs, storage, signal); return
        }
        if (node.type === 'describe-image' || node.type === 'prompt-enhancer' || node.type === 'llm') {await generateText(claim, inputs, storage, signal); return}
        if (node.type === 'remove-background') {await backgroundRemoval(claim, inputs, storage, signal); return}
        const sources = (node.type === 'output' ? inputs.media?.images : inputs.image?.images) ?? []
        if (node.type === 'output' && (node.config.format === 'original' || !sources.length && inputs.media?.text !== null && inputs.media?.text !== undefined)) {
            await repository.finish(claim.step.id, claim.token, 'succeeded', {images: await imageValues(sources.map(image => image.url)), text: inputs.media?.text ?? null}); return
        }
        if (!sources.length) invalid('Connect an image to this processing node')
        let operation: LocalPipelineImageOperation
        if (node.type === 'crop') operation = {type: 'crop', config: node.config}
        else if (node.type === 'resize') operation = {type: 'resize', config: node.config}
        else if (node.type === 'upscale') operation = {type: 'upscale', config: {scale: node.config.scale}}
        else if (node.type === 'output' && node.config.format !== 'original') operation = {type: 'convert', config: {format: node.config.format, quality: node.config.quality}}
        else invalid('Unsupported processing node')
        await stageLocal(claim, sources, operation!, storage, signal, node.type === 'output' ? inputs.media?.text ?? null : null)
    }
    async function advance(id: string) {
        options.signal?.throwIfAborted()
        const storage = await repository.storage()
        await priceRefresh(storage)
        options.signal?.throwIfAborted()
        const claim = await repository.claim(id)
        if (!claim) {await repository.schedule(id, 15_000); return {run: await repository.detail(id), advanced: false}}
        const controller = new AbortController()
        const cancelExternal = () => controller.abort(options.signal?.reason)
        options.signal?.addEventListener('abort', cancelExternal, {once: true})
        if(options.signal?.aborted) cancelExternal()
        const deadline = setTimeout(() => controller.abort(new Error('Pipeline step deadline exceeded')), 15 * 60_000)
        let renewing = false
        const heartbeat = setInterval(() => {
            if (renewing) return
            renewing = true
            void repository.heartbeat(claim.step.id, claim.token).then(live => {if (!live) controller.abort()})
                .catch(() => controller.abort()).finally(() => {renewing = false})
        }, 15_000)
        try {await execute(claim, storage, controller.signal)}
        catch (error) {
            const failure = safePipelineError(error)
            await repository.finish(claim.step.id, claim.token, failure.code === 'CAPACITY_UNAVAILABLE' ? 'queued' : 'failed', claim.step.value, failure)
        } finally {clearTimeout(deadline); clearInterval(heartbeat); options.signal?.removeEventListener('abort', cancelExternal)}
        const run = await repository.detail(id)
        const waiting = run.status === 'awaiting-price' || run.items.some(item => item.steps.some(step => step.backgroundRemovalJobId && step.status === 'queued'))
        await repository.schedule(id, waiting ? 15_000 : 0)
        return {run, advanced: true}
    }
    async function get(id: string) {
        await priceRefresh(await repository.storage())
        const run = await repository.detail(id)
        // An accepted job remains durable if a cold proxy could not acknowledge
        // its initial wake. Account-authorized status reads provide recovery.
        const workerWake = !run.cancelRequested && ['queued', 'running', 'awaiting-price'].includes(run.status)
            ? await wakePipelineWorker({budgetMs: 1500}) : undefined
        return {run, ...(workerWake ? {workerWake} : {})}
    }
    return {advance, get, execute}
}


/** Fair bounded worker discovery; no session token or account secret is returned. */
export async function listRunnablePipelineRunAccounts(limit = 10) {
    const db = getDatabase()
    const rows = await db.select({runId: pipelineRuns.id, userId: users.id, organizationId: users.organizationId, username: users.username,
        displayName: users.displayName, role: users.role, organizationName: organizations.name, isBootstrapOwner: users.isBootstrapOwner, authVersion: users.authVersion})
        .from(pipelineRuns).innerJoin(users, and(eq(users.id, pipelineRuns.userId), eq(users.organizationId, pipelineRuns.organizationId)))
        .innerJoin(organizations, eq(organizations.id, users.organizationId)).where(and(inArray(pipelineRuns.status, ['queued', 'running', 'awaiting-price']),
            eq(pipelineRuns.cancelRequested, false), isNull(users.disabledAt), lte(pipelineRuns.nextAttemptAt, sql`CURRENT_TIMESTAMP`)))
        .orderBy(asc(pipelineRuns.nextAttemptAt), asc(pipelineRuns.updatedAt), asc(pipelineRuns.id)).limit(Math.max(1, Math.min(20, Math.floor(limit))))
    return rows.map(({runId, ...actor}) => ({runId, actor}))
}
/** Include future-scheduled work: delayed pricing and live leases must keep the runner awake. */
export async function hasPendingPipelineWorkerWork(db: ReturnType<typeof getDatabase> = getDatabase()): Promise<boolean> {
    const result = await db.execute<{pending: boolean}>(sql`SELECT EXISTS (
        SELECT 1 FROM pipeline_run r JOIN app_user u ON u.id = r.user_id AND u.organization_id = r.organization_id
        WHERE r.status IN ('queued', 'running', 'awaiting-price') AND NOT r.cancel_requested AND u.disabled_at IS NULL
    ) OR EXISTS (
        SELECT 1 FROM pipeline_run_step WHERE active AND status = 'running' AND lease_expires_at > CURRENT_TIMESTAMP
    ) OR EXISTS (SELECT 1 FROM background_removal_job WHERE status IN ('queued', 'running')) AS pending`)
    return result.rows[0]?.pending === true
}
export async function advancePipelineRun(actor: AuthContext, runId: string, options: {runtimeConfig: Record<string, unknown>; signal?: AbortSignal}) {
    return createPipelineExecutor(actor, createPipelineRepository(actor), options).advance(runId)
}
