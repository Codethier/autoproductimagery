import {randomUUID, createHash} from 'node:crypto'
import {and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, sql} from 'drizzle-orm'
import {createError} from 'h3'
import {pipelines, pipelineRuns, pipelineRunItems, pipelineRunSteps, pipelineStepOutputs, systemPrompt, users,
    accountGenerationCharges, assets, type PipelineRunState, type PipelineStepState} from '../db/schema'
import {getDatabase} from './lib/db'
import {useUserFS} from './useUserFS'
import type {AssetActor} from './assetAccess'
import {assertGenerationCredit} from './accountBilling'
import {createPeopleRepository} from './peopleRepository'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {formatUsdUnits} from '../../schemas/account-billing'
import {SavePipelineSchema, UpdatePipelineSchema, StartPipelineRunSchema, RetryPipelineRunSchema,
    getPipelineExecutionNodes, pipelineRunIssues, pipelineExpectedNodeOutputs, PIPELINE_LIMITS,
    type PipelineDTO, type PipelineListDTO, type PipelineRunDTO, type PipelineRunStepDTO, type PipelineValue,
    type PipelineImageValue, type PipelineDefinition, type PipelineNode, type PipelineRunListDTO} from '../../schemas/pipelines'

type Database = ReturnType<typeof getDatabase>
export type PipelineTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type PipelineActor = AssetActor & {authVersion?: number}
export type PipelineRunRecord = typeof pipelineRuns.$inferSelect
export type PipelineStepRecord = typeof pipelineRunSteps.$inferSelect
export const PIPELINE_STEP_LEASE_MS = 16 * 60_000
export const MAX_ACTIVE_PIPELINE_RUNS = 20
export const MAX_ACTIVE_PIPELINE_RUNS_PER_USER = 3
export const MAX_RUNNING_PIPELINE_STEPS = 3
const liveStatuses: PipelineRunState[] = ['queued', 'running', 'awaiting-price']
const terminalStepStatuses: PipelineStepState[] = ['succeeded', 'failed', 'skipped', 'cancelled', 'interrupted']
const date = (value: string | null) => value ? new Date(value).toISOString() : null
const invalid = (message = 'Invalid pipeline request'): never => {throw createError({statusCode: 400, statusMessage: message})}
export const emptyPipelineValue = (): PipelineValue => ({images: [], text: null})
export function safePipelineError(error: unknown) {
    const value = error && typeof error === 'object' ? error as {statusCode?: number; code?: string; data?: {code?: string}; retryable?: boolean} : {}
    const status = value.statusCode
    const code = value.code ?? value.data?.code
    if (status === 402) return {code: 'CREDIT_EXHAUSTED', message: 'Your available credit is exhausted. Ask your organization owner to update your balance.', retryable: true}
    if (status === 409) return {code: 'WORK_BLOCKED', message: 'This step is waiting for confirmed prices or an active execution to finish.', retryable: true}
    if ([401, 403, 404, 410, 425].includes(status ?? 0)) return {code: 'SOURCE_UNAVAILABLE', message: 'A required image or account is no longer available.', retryable: false}
    if (status === 429) return {code: 'CAPACITY_UNAVAILABLE', message: 'Processing capacity is busy. Retry this step later.', retryable: true}
    if (status === 504 || code?.includes('TIMEOUT')) return {code: 'STEP_TIMEOUT', message: 'This step exceeded its time limit.', retryable: true}
    if (status === 400 || status === 413 || status === 415) return {code: 'INVALID_STEP_INPUT', message: 'This step has invalid or unsupported input or settings.', retryable: false}
    return {code: 'STEP_FAILED', message: 'This step could not finish. Previously completed outputs and charges are preserved.', retryable: true}
}
export function pipelineRequestError(error: unknown): never {
    const value = error as {statusCode?: number; statusMessage?: string; data?: unknown}
    if (value && typeof value.statusCode === 'number' && [400, 401, 402, 403, 404, 409, 413, 415, 429].includes(value.statusCode)) {
        throw createError({statusCode: value.statusCode, statusMessage: value.statusMessage ?? 'Pipeline request failed'})
    }
    console.error('Pipeline storage is temporarily unavailable.')
    throw createError({statusCode: 503, statusMessage: 'Pipeline storage is temporarily unavailable'})
}
export function pipelineItemState(steps: Array<{status: PipelineStepState}>): PipelineRunState {
    if (steps.some(step => step.status === 'running')) return 'running'
    if (steps.some(step => step.status === 'awaiting-price')) return 'awaiting-price'
    if (steps.some(step => step.status === 'queued')) return 'queued'
    if (steps.every(step => step.status === 'succeeded')) return 'succeeded'
    const failures = steps.some(step => ['failed', 'skipped', 'interrupted'].includes(step.status))
    if (failures && steps.some(step => step.status === 'succeeded')) return 'partial'
    if (steps.some(step => step.status === 'interrupted')) return 'interrupted'
    if (steps.some(step => step.status === 'cancelled') && !failures) return 'cancelled'
    return 'failed'
}

export function createPipelineRepository(actor: PipelineActor, db: Database = getDatabase(),
    options: {storage?: Awaited<ReturnType<typeof useUserFS>>; leaseMs?: number} = {}) {
    const scope = (table: {organizationId: typeof pipelineRuns.organizationId; userId: typeof pipelineRuns.userId}) =>
        and(eq(table.organizationId, actor.organizationId), eq(table.userId, actor.userId))
    const stepScope = () => and(eq(pipelineRunSteps.organizationId, actor.organizationId), eq(pipelineRunSteps.userId, actor.userId))
    const runScope = () => and(eq(pipelineRuns.organizationId, actor.organizationId), eq(pipelineRuns.userId, actor.userId))
    let storagePromise: Promise<Awaited<ReturnType<typeof useUserFS>>> | undefined
    const storage = () => storagePromise ??= options.storage ? Promise.resolve(options.storage) : useUserFS(actor, undefined, db)
    const leaseMs = Math.max(30_000, Math.min(PIPELINE_STEP_LEASE_MS, options.leaseMs ?? PIPELINE_STEP_LEASE_MS))
    const expiry = () => sql`CURRENT_TIMESTAMP + (${leaseMs} * interval '1 millisecond')`
    const peopleRepository = createPeopleRepository(actor, db)
    const peopleSources = (nodes: PipelineNode[]) => [...new Set(nodes.flatMap(node => node.type === 'people-input' ? node.config.images : []))]
    async function assertPeopleSources(nodes: PipelineNode[], executor: Database | PipelineTransaction = db, lockProfiles = false) {
        const paths = peopleSources(nodes)
        if (!paths.length) return
        const visible = await peopleRepository.visiblePhotoUrls(paths, executor, lockProfiles)
        if (paths.some(path => !visible.has(path))) throw createError({statusCode: 404, statusMessage: 'A selected People picture is no longer available'})
    }
    async function assertPeopleNodeSources(graph: PipelineDefinition, nodeId: string) {
        await assertPeopleSources(getPipelineExecutionNodes(graph, nodeId))
    }
    const lockQueue = (tx: PipelineTransaction) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('autoproductimagery:pipeline-admission:v1', 0))`)
    async function activeActor(tx: PipelineTransaction) {
        const [user] = await tx.select().from(users).where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId), isNull(users.disabledAt))).for('update').limit(1)
        if (!user || actor.authVersion !== undefined && user.authVersion !== actor.authVersion) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
        return user
    }
    const validId = (id: string) => {if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) throw createError({statusCode: 404, statusMessage: 'Pipeline not found'}); return id}
    function pipelineDTO(row: typeof pipelines.$inferSelect): PipelineDTO {
        return {id: row.id, name: row.name, description: row.description, revision: row.revision, definition: row.definition,
            createdAt: date(row.createdAt)!, updatedAt: date(row.updatedAt)!}
    }
    async function requirePipeline(id: string, executor: Database | PipelineTransaction = db) {
        const [row] = await executor.select().from(pipelines).where(and(eq(pipelines.id, validId(id)), eq(pipelines.organizationId, actor.organizationId), eq(pipelines.userId, actor.userId), isNull(pipelines.deletedAt))).limit(1)
        if (!row) throw createError({statusCode: 404, statusMessage: 'Pipeline not found'})
        return row
    }
    async function requireRun(id: string, executor: Database | PipelineTransaction = db, lock = false) {
        const query = executor.select().from(pipelineRuns).where(and(eq(pipelineRuns.id, validId(id)), runScope())).limit(1)
        const [row] = lock ? await query.for('update') : await query
        if (!row) throw createError({statusCode: 404, statusMessage: 'Pipeline run not found'})
        return row
    }
    const fingerprint = (kind: string, search: string) => createHash('sha256').update(`${actor.organizationId}:${actor.userId}:${kind}:${search}`).digest('hex')
    function cursor(input: string | undefined, kind: string, search: string) {
        if (!input) return undefined
        try {
            const value = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as {id: string; at: string; owner: string; kind: string; search: string}
            if (value.owner !== fingerprint(kind, search) || !Number.isFinite(Date.parse(value.at))) invalid()
            validId(value.id)
            return value
        } catch {return invalid('Invalid pipeline list cursor')}
    }
    const nextCursor = (row: {id: string; createdAt: string}, kind: string, search: string) => Buffer.from(JSON.stringify({id: row.id, at: row.createdAt, owner: fingerprint(kind, search)})).toString('base64url')
    async function list(input: {limit: number; cursor?: string; search: string}): Promise<PipelineListDTO> {
        const after = cursor(input.cursor, 'pipelines', input.search)
        const rows = await db.select().from(pipelines).where(and(eq(pipelines.organizationId, actor.organizationId), eq(pipelines.userId, actor.userId), isNull(pipelines.deletedAt),
            input.search ? sql`position(lower(${input.search}) in lower(${pipelines.name})) > 0` : undefined,
            after ? sql`(${pipelines.createdAt}, ${pipelines.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined))
            .orderBy(desc(pipelines.createdAt), desc(pipelines.id)).limit(input.limit + 1)
        const cache = new Map<string, Promise<PipelineImageValue | null>>()
        await preloadOwned(rows.slice(0,input.limit).flatMap(row=>definitionImagePaths(row.definition)), cache)
        return {pipelines: await Promise.all(rows.slice(0, input.limit).map(row => publicPipeline(row, cache))), nextCursor: rows.length > input.limit ? nextCursor(rows[input.limit - 1]!, 'pipelines', input.search) : null}
    }
    function definitionImagePaths(graph: PipelineDefinition) {
        return graphSources(graph, graph.nodes, {})
    }
    async function preloadOwned(paths: string[], cache: Map<string, Promise<PipelineImageValue | null>>) {
        const unique = [...new Set(paths)]
        const chunks = []
        for (let offset=0;offset<unique.length;offset+=2500) chunks.push(unique.slice(offset,offset+2500))
        for (const chunk of chunks) {
            const result = await (await storage()).ownedImageMetadata(chunk)
            const images = new Map(result.images.map(image => [image.url, image]))
            for (const url of result.ownedUrls) cache.set(url,Promise.resolve(images.get(url) ?? null))
        }
    }
    async function visibleDefinition(graph: PipelineDefinition, cache = new Map<string, Promise<PipelineImageValue | null>>()) {
        const copy = structuredClone(graph)
        const visiblePeople = await peopleRepository.visiblePhotoUrls(peopleSources(graph.nodes))
        const accessible = async (url: string) => {
            let result = cache.get(url)
            if (!result) {
                result = imageValue(url).catch(error => {
                    if ([401, 403, 404, 410, 425].includes(Number((error as {statusCode?: number}).statusCode))) return null
                    throw error
                })
                cache.set(url, result)
            }
            return Boolean(await result)
        }
        for (const node of copy.nodes) {
            if (node.type === 'image-input' && node.config.defaultImage && !await accessible(node.config.defaultImage)) delete node.config.defaultImage
            else if (node.type === 'static-image') {
                const images = []
                for (const url of node.config.images) if (await accessible(url)) images.push(url)
                node.config.images = images
            } else if (node.type === 'people-input') {
                const images = []
                for (const url of node.config.images) if (visiblePeople.has(url) && await accessible(url)) images.push(url)
                node.config.images = images
            } else if (node.type === 'generate-image') {
                const images = []
                for (const url of node.config.referenceImages) if (await accessible(url)) images.push(url)
                node.config.referenceImages = images
                if (node.config.maskImage && !await accessible(node.config.maskImage)) delete node.config.maskImage
            }
        }
        return copy
    }
    async function publicPipeline(row: typeof pipelines.$inferSelect, cache = new Map<string, Promise<PipelineImageValue | null>>()) {
        return {...pipelineDTO(row), definition: await visibleDefinition(row.definition, cache)}
    }
    async function get(id: string) {
        const row=await requirePipeline(id), cache=new Map<string,Promise<PipelineImageValue|null>>()
        await preloadOwned(definitionImagePaths(row.definition),cache)
        return {pipeline: await publicPipeline(row,cache)}
    }
    async function create(raw: unknown) {
        const parsed = SavePipelineSchema.safeParse(raw); if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid pipeline request'})
        await assertPeopleSources(parsed.data.definition.nodes)
        await (await storage()).assertReadableImages(graphSources(parsed.data.definition, parsed.data.definition.nodes, {}))
        const created = await db.transaction(async tx => {
            await activeActor(tx)
            await assertPeopleSources(parsed.data.definition.nodes, tx, true)
            const [total] = await tx.select({value: count()}).from(pipelines).where(and(eq(pipelines.organizationId, actor.organizationId), eq(pipelines.userId, actor.userId), isNull(pipelines.deletedAt)))
            if (Number(total?.value ?? 0) >= 100) throw createError({statusCode: 409, statusMessage: 'You may save at most 100 pipelines'})
            const [row] = await tx.insert(pipelines).values({id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, ...parsed.data}).returning()
            return row!
        })
        return {pipeline: await publicPipeline(created)}
    }
    async function update(id: string, raw: unknown) {
        const parsed = UpdatePipelineSchema.safeParse(raw); if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid pipeline request'})
        await assertPeopleSources(parsed.data.definition.nodes)
        await (await storage()).assertReadableImages(graphSources(parsed.data.definition, parsed.data.definition.nodes, {}))
        const updated = await db.transaction(async tx => {
            await activeActor(tx)
            await assertPeopleSources(parsed.data.definition.nodes, tx, true)
            await requirePipeline(id, tx)
            const {revision, ...values} = parsed.data
            const [row] = await tx.update(pipelines).set({...values, revision: revision + 1, updatedAt: sql`CURRENT_TIMESTAMP`})
                .where(and(eq(pipelines.id, id), eq(pipelines.organizationId, actor.organizationId), eq(pipelines.userId, actor.userId), isNull(pipelines.deletedAt), eq(pipelines.revision, revision))).returning()
            if (!row) throw createError({statusCode: 409, statusMessage: 'This pipeline changed in another tab. Reload before saving.'})
            return row
        })
        return {pipeline: await publicPipeline(updated)}
    }
    async function remove(id: string) {
        await db.transaction(async tx => {await activeActor(tx); await requirePipeline(id, tx)
            await tx.update(pipelines).set({deletedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`}).where(eq(pipelines.id, id))})
        return {ok: true}
    }
    function graphSources(graph: PipelineDefinition, nodes: PipelineNode[], inputs: Record<string, string>, batchInputNodeId?: string) {
        return [...new Set(nodes.flatMap(node => {
            if (node.type === 'image-input') return node.id === batchInputNodeId ? [] : [inputs[node.id] || node.config.defaultImage].filter((url): url is string => Boolean(url))
            if (node.type === 'static-image' || node.type === 'people-input') return node.config.images
            if (node.type === 'generate-image') return [...node.config.referenceImages, ...(node.config.maskImage ? [node.config.maskImage] : [])]
            return []
        }))]
    }
    function boundExecution(nodes: PipelineNode[], graph: PipelineDefinition, items: number) {
        const counts = new Map<string, number>(); let calls = 0, images = 0
        for (const node of nodes) {
            const connected = graph.edges.filter(edge => edge.target === node.id && ['image', 'media'].includes(edge.targetPort) && edge.sourcePort === 'image')
            const sourceCount = connected.reduce((total, edge) => total + (counts.get(edge.source) ?? 0), 0)
            let outputCount = sourceCount
            if (node.type === 'image-input') outputCount = 1
            else if (node.type === 'static-image' || node.type === 'people-input') outputCount = node.config.images.length
            else if (['static-text', 'text-input', 'describe-image', 'llm', 'prompt-enhancer', 'prompt-concatenator', 'sticky-note'].includes(node.type)) outputCount = 0
            else outputCount = pipelineExpectedNodeOutputs(node, sourceCount)
            if (['generate-image', 'expand', 'translate'].includes(node.type) || node.type === 'upscale' && node.config.mode === 'ai') {if (sourceCount > 20) invalid('A generation node accepts at most 20 connected images per item')}
            if (outputCount > PIPELINE_LIMITS.imagesPerStep) invalid('A pipeline node would produce too many images')
            if (['generate-image', 'expand', 'translate'].includes(node.type) || node.type === 'upscale' && node.config.mode === 'ai') calls += Math.max(1, sourceCount)
            if (['describe-image', 'llm', 'prompt-enhancer'].includes(node.type)) calls++
            images += outputCount; counts.set(node.id, outputCount)
        }
        if (calls * items > PIPELINE_LIMITS.paidCallsPerRun || images * items > 2000) invalid('This batch would exceed the pipeline processing limit. Use fewer input images or branches.')
    }
    async function start(id: string, raw: unknown) {
        const parsed = StartPipelineRunSchema.safeParse(raw); if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid pipeline request'})
        const input = parsed.data, definition = (await requirePipeline(id)).definition
        const issues = pipelineRunIssues(definition, input.targetNodeId); if (issues.length) invalid(issues.join(' ').slice(0, 500))
        const nodes = getPipelineExecutionNodes(definition, input.targetNodeId)
        if (!nodes.length) invalid('Add a runnable pipeline output')
        if (input.batchInputNodeId && !nodes.some(node => node.id === input.batchInputNodeId && node.type === 'image-input')) invalid('Choose an Image Input in this run')
        if (input.inputImages.length && !input.batchInputNodeId) invalid('Choose an Image Input for the batch')
        for (const key of Object.keys(input.inputs)) if (!nodes.some(node => node.id === key && ['image-input', 'text-input'].includes(node.type))) invalid('Unknown pipeline input')
        for (const node of nodes) {
            if (node.type === 'image-input' && node.config.required && !(node.id === input.batchInputNodeId && input.inputImages.length) && !(input.inputs[node.id] || node.config.defaultImage)) invalid(`${node.label}: choose an image.`)
            if (node.type === 'text-input' && node.config.required && !(input.inputs[node.id] ?? node.config.defaultValue).trim()) invalid(`${node.label}: enter text.`)
        }
        const hasPaidNodes = nodes.some(node => ['generate-image','expand','translate','describe-image','prompt-enhancer','llm'].includes(node.type) || node.type === 'upscale' && node.config.mode === 'ai')
        const images = input.inputImages.length ? input.inputImages : [null]
        boundExecution(nodes, definition, images.length)
        const sourceUrls = [...input.inputImages, ...graphSources(definition, nodes, input.inputs, input.batchInputNodeId)]
        await assertPeopleSources(nodes)
        await (await storage()).assertReadableImages(sourceUrls)
        const runId = randomUUID()
        const existing = await db.select().from(pipelineRuns).where(and(runScope(), eq(pipelineRuns.idempotencyKey, input.idempotencyKey))).limit(1)
        if (existing[0]) {
            if (existing[0].pipelineId !== id || existing[0].revision !== input.revision || JSON.stringify(existing[0].inputs) !== JSON.stringify(input.inputs)
                || existing[0].batchInputNodeId !== (input.batchInputNodeId ?? null) || existing[0].targetNodeId !== (input.targetNodeId ?? null)) throw createError({statusCode: 409, statusMessage: 'This pipeline request key was already used'})
            const previous = await db.select({inputUrl: pipelineRunItems.inputUrl}).from(pipelineRunItems).where(eq(pipelineRunItems.runId, existing[0].id)).orderBy(asc(pipelineRunItems.index))
            if (JSON.stringify(previous.map(item => item.inputUrl)) !== JSON.stringify(images)) throw createError({statusCode: 409, statusMessage: 'This pipeline request key was already used'})
            return {run: await detail(existing[0].id)}
        }
        const persistedRunId = await db.transaction(async tx => {
            await lockQueue(tx); const user = await activeActor(tx)
            const [repeated] = await tx.select().from(pipelineRuns).where(and(runScope(), eq(pipelineRuns.idempotencyKey, input.idempotencyKey))).limit(1)
            if (repeated) {
                const previous = await tx.select({inputUrl: pipelineRunItems.inputUrl}).from(pipelineRunItems).where(eq(pipelineRunItems.runId, repeated.id)).orderBy(asc(pipelineRunItems.index))
                if (repeated.pipelineId !== id || repeated.revision !== input.revision || JSON.stringify(repeated.inputs) !== JSON.stringify(input.inputs) || repeated.batchInputNodeId !== (input.batchInputNodeId ?? null) || repeated.targetNodeId !== (input.targetNodeId ?? null) || JSON.stringify(previous.map(item => item.inputUrl)) !== JSON.stringify(images)) throw createError({statusCode:409,statusMessage:'This pipeline request key was already used'})
                return repeated.id
            }
            const current = await requirePipeline(id, tx)
            if (current.revision !== input.revision || JSON.stringify(current.definition) !== JSON.stringify(definition)) throw createError({statusCode: 409, statusMessage: 'Save or reload the current pipeline before running it'})
            await assertPeopleSources(nodes, tx, true)
            const [personal] = await tx.select({value: count()}).from(pipelineRuns).where(and(runScope(), inArray(pipelineRuns.status, liveStatuses)))
            const cap = user.creditBalanceUnits === null || !hasPaidNodes ? MAX_ACTIVE_PIPELINE_RUNS_PER_USER : 1
            if (Number(personal?.value ?? 0) >= cap) throw createError({statusCode: 429, statusMessage: 'Finish or cancel your active pipeline runs first'})
            const [global] = await tx.select({value: count()}).from(pipelineRuns).where(inArray(pipelineRuns.status, liveStatuses))
            if (Number(global?.value ?? 0) >= MAX_ACTIVE_PIPELINE_RUNS) throw createError({statusCode: 429, statusMessage: 'Pipeline processing is busy; try again later'})
            if (hasPaidNodes) await assertGenerationCredit(tx, actor, runId)
            await tx.insert(pipelineRuns).values({id: runId, pipelineId: id, organizationId: actor.organizationId, userId: actor.userId, name: current.name,
                revision: current.revision, definition, inputs: input.inputs, batchInputNodeId: input.batchInputNodeId ?? null, targetNodeId: input.targetNodeId ?? null, idempotencyKey: input.idempotencyKey})
            for (const [index, inputUrl] of images.entries()) {
                const itemId = randomUUID()
                await tx.insert(pipelineRunItems).values({id: itemId, runId, organizationId: actor.organizationId, userId: actor.userId, index, inputUrl})
                await tx.insert(pipelineRunSteps).values(nodes.map(node => ({id: randomUUID(), runId, itemId, organizationId: actor.organizationId, userId: actor.userId, nodeId: node.id, type: node.type})))
            }
            return runId
        })
        await notify(persistedRunId)
        return {run: await detail(persistedRunId)}
    }
    async function allSteps(runId: string, executor: Database | PipelineTransaction = db, active = true) {
        return executor.select().from(pipelineRunSteps).where(and(eq(pipelineRunSteps.runId, runId), stepScope(), active ? eq(pipelineRunSteps.active, true) : undefined)).orderBy(asc(pipelineRunSteps.createdAt), asc(pipelineRunSteps.id))
    }
    async function generationRows(stepId: string) {
        return db.select().from(systemPrompt).where(and(eq(systemPrompt.pipelineStepId, stepId), eq(systemPrompt.organizationId, actor.organizationId), eq(systemPrompt.userId, actor.userId))).orderBy(asc(systemPrompt.id)).limit(51)
    }
    async function imageValue(url: string, generationId?: number): Promise<PipelineImageValue> {
        const asset = await (await storage()).assetByUrl(url)
        if (asset.kind !== 'file' || !asset.id) throw createError({statusCode: 404, statusMessage: 'Image not found'})
        const [metadata] = await db.select({width: assets.width, height: assets.height, mimeType: assets.mimeType, bytes: assets.byteSize}).from(assets)
            .where(and(eq(assets.id, asset.id), eq(assets.organizationId, actor.organizationId), isNull(assets.deletedAt))).limit(1)
        if (!metadata) throw createError({statusCode:404,statusMessage:'Image not found'})
        return {id: asset.id, url: asset.url, name: asset.name, priceUsd: asset.priceUsd ?? null, priceSource: asset.priceSource ?? null,
            ...(metadata.width !== null ? {width:metadata.width} : {}), ...(metadata.height !== null ? {height:metadata.height} : {}),
            ...(metadata.mimeType !== null ? {mimeType:metadata.mimeType} : {}), ...(metadata.bytes !== null ? {bytes:metadata.bytes} : {}),
            ...(generationId ? {generationId} : {})}
    }
    async function visibleValue(value: PipelineValue | null, cache = new Map<string, Promise<PipelineImageValue | null>>()): Promise<PipelineValue | null> {
        if (!value) return null
        const images: PipelineImageValue[] = []
        for (const image of value.images.slice(0, PIPELINE_LIMITS.imagesPerStep)) {
            let work = cache.get(image.url)
            if (!work) {work = imageValue(image.url).catch(error => {if ([401,403,404,410,425].includes(Number((error as {statusCode?: number}).statusCode))) return null; throw error}); cache.set(image.url, work)}
            const visible = await work
            if (visible) images.push({...visible, ...(image.generationId ? {generationId: image.generationId} : {})})
        }
        return {images, text: value.text}
    }
    async function reconcileSteps(runId: string) {
        const run = await requireRun(runId), steps = await allSteps(runId)
        for (const step of steps.filter(value => value.status === 'awaiting-price' || value.status === 'running' && value.leaseExpiresAt && Date.parse(value.leaseExpiresAt) <= Date.now())) {
            const rows = await generationRows(step.id)
            const terminal = rows.length && rows.every(row => row.status !== 'pending')
            const confirmed = terminal && rows.every(row => row.billingState === 'released' || hasConfirmedGenerationPrice(row))
            let status: PipelineStepState, value: PipelineValue | null = null, error = step.error
            if (confirmed) {
                const good = rows.filter(row => row.status === 'succeeded' && hasConfirmedGenerationPrice(row))
                const images: PipelineImageValue[] = []
                for (const row of good.filter(row => row.outputImage && !row.outputImageDeletedAt)) {
                    try {images.push(await imageValue(row.outputImage, row.id))} catch { /* expired or withdrawn images stay private */ }
                }
                value = {images, text: good.find(row => row.pipelineTextConfig)?.outputMetadata?.responseText ?? null}
                status = rows.some(row => row.status === 'failed') || !good.length ? 'failed' : 'succeeded'
                if (status === 'succeeded' && step.type === 'expand') {
                    const inputEdges = run.definition.edges.filter(edge => edge.target === step.nodeId && edge.targetPort === 'image')
                    const sourceCount = inputEdges.reduce((total, edge) => total + (steps.find(value => value.itemId === step.itemId && value.nodeId === edge.source)?.value?.images.length ?? 0), 0)
                    const completedSources = new Set(rows.map(row => row.batchId).filter(Boolean)).size
                    if (completedSources < sourceCount) status = 'queued'
                }
                if (good.filter(row => row.outputImage).length !== images.length) {
                    status = 'failed'; error = {code:'SOURCE_UNAVAILABLE',message:'A completed output is expired, deleted, or no longer available. Its charge is preserved.',retryable:false}
                }
                if (rows.length > PIPELINE_LIMITS.imagesPerStep) {status = 'failed';value.images = value.images.slice(0,PIPELINE_LIMITS.imagesPerStep)}
                if (status === 'failed' && error?.code !== 'SOURCE_UNAVAILABLE') error = {code: 'PARTIAL_GENERATION', message: 'Some outputs failed or exceeded the node limit. Confirmed outputs and charges are preserved; retry only if you want another call.', retryable: true}
            } else if (terminal) {
                status = rows.every(row => row.status === 'failed') ? 'failed' : 'awaiting-price'
                if (status === 'failed') error = {code: 'GENERATION_FAILED', message: 'The provider call failed. Any incurred or outstanding charges are preserved.', retryable: true}
            }
            else if (step.status === 'running') {
                status = 'interrupted'; error = {code: 'STEP_INTERRUPTED', message: 'Execution was interrupted. A provider call may already have incurred a charge. Review before retrying.', retryable: true}
            } else continue
            await db.transaction(async tx => {
                await requireRun(runId, tx, true)
                await tx.update(pipelineRunSteps).set({status, value, error, claimToken: null, leaseExpiresAt: null,
                    completedAt: terminalStepStatuses.includes(status) ? sql`CURRENT_TIMESTAMP` : null, updatedAt: sql`CURRENT_TIMESTAMP`})
                    .where(and(eq(pipelineRunSteps.id, step.id), stepScope(), eq(pipelineRunSteps.status, step.status),
                        step.status === 'running' ? lte(pipelineRunSteps.leaseExpiresAt, sql`CURRENT_TIMESTAMP`) : undefined))
            })
        }
        return run
    }
    async function synchronize(runId: string, executor: Database | PipelineTransaction = db) {
        const run = await requireRun(runId, executor), steps = await allSteps(runId, executor)
        // A failed dependency cannot make a downstream paid call. Propagate
        // skips in topological order so an entire abandoned branch terminates.
        for (const itemId of new Set(steps.map(step => step.itemId))) {
            const item = steps.filter(step => step.itemId === itemId)
            for (const node of getPipelineExecutionNodes(run.definition, run.targetNodeId ?? undefined)) {
                const step = item.find(value => value.nodeId === node.id)
                if (step?.status !== 'queued') continue
                const predecessors = run.definition.edges.filter(edge => edge.target === node.id).map(edge => item.find(value => value.nodeId === edge.source)).filter(Boolean)
                if (predecessors.some(value => value && ['failed', 'skipped', 'cancelled', 'interrupted'].includes(value.status))) {
                    await executor.update(pipelineRunSteps).set({status: 'skipped', error: {code: 'DEPENDENCY_FAILED', message: 'A required earlier step did not finish.', retryable: true}, completedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(pipelineRunSteps.id, step.id), eq(pipelineRunSteps.status, 'queued')))
                    step.status = 'skipped'
                }
            }
        }
        const states = [...new Set(steps.map(step => step.itemId))].map(id => pipelineItemState(steps.filter(step => step.itemId === id)))
        let status: PipelineRunState = 'queued'
        if (run.cancelRequested) status = 'cancelled'
        else if (states.includes('running')) status = 'running'
        else if (states.includes('awaiting-price')) status = 'awaiting-price'
        else if (states.includes('queued')) status = 'queued'
        else if (states.every(value => value === 'succeeded')) status = 'succeeded'
        else if (states.some(value => value === 'succeeded' || value === 'partial')) status = 'partial'
        else if (states.includes('interrupted')) status = 'interrupted'
        else status = 'failed'
        if (run.status !== status) await executor.update(pipelineRuns).set({status, updatedAt: sql`CURRENT_TIMESTAMP`,
            completedAt: liveStatuses.includes(status) ? null : sql`CURRENT_TIMESTAMP`}).where(and(eq(pipelineRuns.id, runId), runScope()))
        return status
    }
    async function detail(id: string): Promise<PipelineRunDTO> {
        await reconcileSteps(id)
        await db.transaction(async tx => {await requireRun(id, tx, true); await synchronize(id, tx)})
        const run = await requireRun(id), steps = await allSteps(id)
        const items = await db.select().from(pipelineRunItems).where(and(eq(pipelineRunItems.runId, id), eq(pipelineRunItems.organizationId, actor.organizationId), eq(pipelineRunItems.userId, actor.userId))).orderBy(asc(pipelineRunItems.index)).limit(PIPELINE_LIMITS.batchImages)
        const linked = await db.select({id: systemPrompt.id, stepId: systemPrompt.pipelineStepId}).from(systemPrompt)
            .innerJoin(pipelineRunSteps, eq(systemPrompt.pipelineStepId, pipelineRunSteps.id)).where(and(eq(pipelineRunSteps.runId, id), stepScope(), eq(systemPrompt.organizationId, actor.organizationId), eq(systemPrompt.userId, actor.userId)))
        const generations = new Map<string, number[]>()
        for (const row of linked) if (row.stepId) generations.set(row.stepId, [...(generations.get(row.stepId) ?? []), row.id])
        const outputItems = []
        const projectionCache = new Map<string, Promise<PipelineImageValue | null>>()
        const visiblePeople = await peopleRepository.visiblePhotoUrls(peopleSources(run.definition.nodes))
        await preloadOwned([...definitionImagePaths(run.definition), ...items.flatMap(item=>item.inputUrl?[item.inputUrl]:[]),
            ...steps.flatMap(step=>step.value?.images.map(image=>image.url)??[])], projectionCache)
        for (const item of items) {
            const ownSteps = steps.filter(step => step.itemId === item.id), outputSteps: PipelineRunStepDTO[] = []
            for (const node of getPipelineExecutionNodes(run.definition, run.targetNodeId ?? undefined)) {
                const step = ownSteps.find(value => value.nodeId === node.id); if (!step) continue
                const value = ['succeeded', 'failed'].includes(step.status) ? await visibleValue(step.value, projectionCache) : null
                if (value) {
                    const withdrawn = new Set(peopleSources(getPipelineExecutionNodes(run.definition, node.id)).filter(url => !visiblePeople.has(url)))
                    value.images = value.images.filter(image => !withdrawn.has(image.url))
                }
                outputSteps.push({id: step.id, nodeId: step.nodeId, type: node.type, status: step.status,
                    value,
                    error: step.error, generationIds: generations.get(step.id) ?? [], backgroundRemovalJobId: step.backgroundRemovalJobId,
                    startedAt: date(step.startedAt), completedAt: date(step.completedAt)})
            }
            let inputUrl = item.inputUrl
            if (inputUrl) {
                const cached=projectionCache.get(inputUrl)
                if (cached) {if(!await cached)inputUrl=null}
                else try {await imageValue(inputUrl)} catch {inputUrl = null}
            }
            outputItems.push({id: item.id, index: item.index, inputUrl, status: pipelineItemState(ownSteps), steps: outputSteps})
        }
        const [totals] = await db.select({confirmed: sql<string>`COALESCE(SUM(${accountGenerationCharges.confirmedUnits}) FILTER (WHERE ${accountGenerationCharges.state} = 'confirmed'), 0)::text`,
            outstanding: sql<number>`COUNT(*) FILTER (WHERE ${accountGenerationCharges.state} = 'outstanding')::int`})
            .from(accountGenerationCharges).innerJoin(systemPrompt, eq(accountGenerationCharges.generationId, systemPrompt.id)).innerJoin(pipelineRunSteps, eq(systemPrompt.pipelineStepId, pipelineRunSteps.id))
            .where(and(eq(pipelineRunSteps.runId, id), stepScope(), eq(accountGenerationCharges.organizationId, actor.organizationId), eq(accountGenerationCharges.userId, actor.userId)))
        return {id: run.id, pipelineId: run.pipelineId, name: run.name, revision: run.revision, definition: await visibleDefinition(run.definition, projectionCache), targetNodeId: run.targetNodeId,
            status: run.status, createdAt: date(run.createdAt)!, updatedAt: date(run.updatedAt)!, completedAt: date(run.completedAt), cancelRequested: run.cancelRequested,
            items: outputItems, summary: {total: items.length, succeeded: outputItems.filter(item => item.status === 'succeeded').length,
                failed: outputItems.filter(item => ['failed', 'partial', 'interrupted'].includes(item.status)).length,
                pending: outputItems.filter(item => liveStatuses.includes(item.status)).length,
                confirmedCostUsd: formatUsdUnits(BigInt((totals?.confirmed ?? '0').split('.')[0]!)), outstandingCount: Number(totals?.outstanding ?? 0)}}
    }
    async function listRuns(input: {limit: number; cursor?: string; search: string}): Promise<PipelineRunListDTO> {
        const after = cursor(input.cursor, 'runs', input.search)
        const rows = await db.select({id: pipelineRuns.id, pipelineId: pipelineRuns.pipelineId, name: pipelineRuns.name, revision: pipelineRuns.revision,
            status: pipelineRuns.status, targetNodeId: pipelineRuns.targetNodeId, createdAt: pipelineRuns.createdAt, updatedAt: pipelineRuns.updatedAt,
            completedAt: pipelineRuns.completedAt, cancelRequested: pipelineRuns.cancelRequested}).from(pipelineRuns).where(and(runScope(),
                input.search ? sql`position(lower(${input.search}) in lower(${pipelineRuns.name})) > 0` : undefined,
                after ? sql`(${pipelineRuns.createdAt}, ${pipelineRuns.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined))
            .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id)).limit(input.limit + 1)
        const page = rows.slice(0, input.limit), ids = page.map(row => row.id)
        const counts = new Map<string, {total: number; succeeded: number; failed: number; pending: number}>()
        const prices = new Map<string, {confirmed: string; outstanding: number}>()
        if (ids.length) {
            const [states, charges] = await Promise.all([
                db.execute(sql`WITH item_states AS (
                    SELECT ${pipelineRunItems.runId} AS run_id, ${pipelineRunItems.id} AS item_id,
                        BOOL_AND(${pipelineRunSteps.status} = 'succeeded') AS good,
                        BOOL_OR(${pipelineRunSteps.status} IN ('queued','running','awaiting-price')) AS pending,
                        BOOL_OR(${pipelineRunSteps.status} IN ('failed','skipped','interrupted')) AS bad
                    FROM ${pipelineRunItems} JOIN ${pipelineRunSteps} ON ${pipelineRunSteps.itemId} = ${pipelineRunItems.id}
                    WHERE ${inArray(pipelineRunItems.runId, ids)} AND ${pipelineRunSteps.active} = true
                      AND ${pipelineRunItems.organizationId} = ${actor.organizationId}::uuid AND ${pipelineRunItems.userId} = ${actor.userId}::uuid
                    GROUP BY ${pipelineRunItems.runId}, ${pipelineRunItems.id}
                ) SELECT run_id, COUNT(*)::int AS total, COUNT(*) FILTER(WHERE good)::int AS succeeded,
                    COUNT(*) FILTER(WHERE bad AND NOT pending)::int AS failed, COUNT(*) FILTER(WHERE pending)::int AS pending FROM item_states GROUP BY run_id`),
                db.execute(sql`SELECT ${pipelineRunSteps.runId} AS run_id,
                    COALESCE(SUM(${accountGenerationCharges.confirmedUnits}) FILTER(WHERE ${accountGenerationCharges.state} = 'confirmed'),0)::text AS confirmed,
                    COUNT(*) FILTER(WHERE ${accountGenerationCharges.state} = 'outstanding')::int AS outstanding
                    FROM ${accountGenerationCharges} JOIN ${systemPrompt} ON ${systemPrompt.id} = ${accountGenerationCharges.generationId}
                      JOIN ${pipelineRunSteps} ON ${pipelineRunSteps.id} = ${systemPrompt.pipelineStepId}
                    WHERE ${inArray(pipelineRunSteps.runId, ids)} AND ${accountGenerationCharges.organizationId} = ${actor.organizationId}::uuid
                        AND ${accountGenerationCharges.userId} = ${actor.userId}::uuid GROUP BY ${pipelineRunSteps.runId}`),
            ])
            for (const row of states.rows as Array<{run_id: string; total: number; succeeded: number; failed: number; pending: number}>) counts.set(row.run_id, row)
            for (const row of charges.rows as Array<{run_id: string; confirmed: string; outstanding: number}>) prices.set(row.run_id, row)
        }
        const runs = page.map(row => ({...row, createdAt: date(row.createdAt)!, updatedAt: date(row.updatedAt)!, completedAt: date(row.completedAt),
            summary: {...(counts.get(row.id) ?? {total: 0, succeeded: 0, failed: 0, pending: 0}),
                confirmedCostUsd: formatUsdUnits(BigInt((prices.get(row.id)?.confirmed ?? '0').split('.')[0]!)), outstandingCount: prices.get(row.id)?.outstanding ?? 0}}))
        return {runs, nextCursor: rows.length > input.limit ? nextCursor(rows[input.limit - 1]!, 'runs', input.search) : null}
    }
    async function claim(id: string) {
        await reconcileSteps(id)
        return db.transaction(async tx => {
            await lockQueue(tx); await activeActor(tx)
            const run = await requireRun(id, tx, true)
            await synchronize(id, tx)
            if (run.cancelRequested) return null
            const steps = await allSteps(id, tx)
            if (steps.some(step => step.status === 'running')) return null
            const [active] = await tx.select({value: count()}).from(pipelineRunSteps).where(and(eq(pipelineRunSteps.status, 'running'), gt(pipelineRunSteps.leaseExpiresAt, sql`CURRENT_TIMESTAMP`)))
            if (Number(active?.value ?? 0) >= MAX_RUNNING_PIPELINE_STEPS) throw createError({statusCode: 429, statusMessage: 'Pipeline processing is busy; try again later'})
            const items = await tx.select().from(pipelineRunItems).where(eq(pipelineRunItems.runId, id)).orderBy(asc(pipelineRunItems.index))
            for (const item of items) for (const node of getPipelineExecutionNodes(run.definition, run.targetNodeId ?? undefined)) {
                const step = steps.find(value => value.itemId === item.id && value.nodeId === node.id)
                if (step?.status !== 'queued') continue
                const dependencies = run.definition.edges.filter(edge => edge.target === node.id).map(edge => steps.find(value => value.itemId === item.id && value.nodeId === edge.source))
                if (dependencies.some(value => value?.status !== 'succeeded')) continue
                const token = randomUUID()
                const [claimed] = await tx.update(pipelineRunSteps).set({status: 'running', claimToken: token, leaseExpiresAt: expiry(),
                    startedAt: step.startedAt ?? sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(pipelineRunSteps.id, step.id), eq(pipelineRunSteps.status, 'queued'))).returning()
                await tx.update(pipelineRuns).set({status: 'running', updatedAt: sql`CURRENT_TIMESTAMP`, completedAt: null}).where(eq(pipelineRuns.id, id))
                return {run, item, step: claimed!, node, dependencies: steps.filter(value => value.itemId === item.id && value.status === 'succeeded'), token}
            }
            return null
        })
    }
    const liveClaim = (stepId: string, token: string) => and(eq(pipelineRunSteps.id, stepId), stepScope(), eq(pipelineRunSteps.active, true),
        eq(pipelineRunSteps.status, 'running'), eq(pipelineRunSteps.claimToken, token), gt(pipelineRunSteps.leaseExpiresAt, sql`CURRENT_TIMESTAMP`))
    async function heartbeat(stepId: string, token: string) {
        const rows = await db.update(pipelineRunSteps).set({leaseExpiresAt: expiry(), updatedAt: sql`CURRENT_TIMESTAMP`}).where(liveClaim(stepId, token)).returning({id: pipelineRunSteps.id})
        return rows.length === 1
    }
    async function providerStarted(stepId: string, token: string, batchId: string) {
        await db.transaction(async tx => {
            await activeActor(tx)
            const [step] = await tx.select().from(pipelineRunSteps).where(liveClaim(stepId, token)).for('update').limit(1)
            if (!step) throw createError({statusCode: 409, statusMessage: 'Pipeline execution ownership expired'})
            const run = await requireRun(step.runId, tx)
            if (run.cancelRequested) throw createError({statusCode: 409, statusMessage: 'Pipeline execution was cancelled'})
            await assertPeopleSources(getPipelineExecutionNodes(run.definition, step.nodeId), tx, true)
            await tx.update(pipelineRunSteps).set({providerStartedAt: sql`CURRENT_TIMESTAMP`, batchId, updatedAt: sql`CURRENT_TIMESTAMP`}).where(liveClaim(stepId, token))
        })
    }
    async function lockPublicationAccounts(tx: PipelineTransaction, sourceUrls: string[]) {
        const owners = sourceUrls.length ? await tx.select({id: assets.ownerUserId}).from(assets)
            .where(and(eq(assets.organizationId, actor.organizationId), inArray(assets.url, [...new Set(sourceUrls)]))) : []
        const ids = [...new Set([actor.userId, ...owners.map(owner => owner.id)])].sort()
        const enabled = await tx.select({id: users.id, authVersion: users.authVersion}).from(users)
            .where(and(eq(users.organizationId, actor.organizationId), inArray(users.id, ids), isNull(users.disabledAt))).orderBy(asc(users.id)).for('share')
        const current = enabled.find(user => user.id === actor.userId)
        if (!current || actor.authVersion !== undefined && current.authVersion !== actor.authVersion) throw createError({statusCode:401,statusMessage:'Unauthorized'})
    }
    async function finish(stepId: string, token: string, status: PipelineStepState, value: PipelineValue | null, error: PipelineStepRecord['error'] = null,
        publish?: (tx: PipelineTransaction) => Promise<void>, publicationSourceUrls: string[] = []) {
        return db.transaction(async tx => {
            // Cancellation/role changes lock users before runs. Publication
            // takes compatible, sorted user locks first, then run/step locks,
            // avoiding a run -> user / user -> run deadlock during long work.
            if (publish) await lockPublicationAccounts(tx, publicationSourceUrls)
            const [known] = await tx.select({runId: pipelineRunSteps.runId}).from(pipelineRunSteps).where(and(eq(pipelineRunSteps.id, stepId), stepScope())).limit(1)
            if (!known) return false
            const run = await requireRun(known.runId, tx, true)
            if (publish && run.cancelRequested) {
                await tx.update(pipelineRunSteps).set({status:'cancelled',claimToken:null,leaseExpiresAt:null,completedAt:sql`CURRENT_TIMESTAMP`,updatedAt:sql`CURRENT_TIMESTAMP`}).where(liveClaim(stepId,token))
                return false
            }
            const [step] = await tx.select().from(pipelineRunSteps).where(liveClaim(stepId, token)).for('update').limit(1)
            if (!step) return false
            if (status === 'succeeded' || publish) await assertPeopleSources(getPipelineExecutionNodes(run.definition, step.nodeId), tx, true)
            if (publish) await publish(tx)
            await tx.update(pipelineRunSteps).set({status, value, error, claimToken: null, leaseExpiresAt: null,
                completedAt: terminalStepStatuses.includes(status) ? sql`CURRENT_TIMESTAMP` : null, updatedAt: sql`CURRENT_TIMESTAMP`}).where(liveClaim(stepId, token))
            await synchronize(step.runId, tx)
            return true
        })
    }
    async function setBackgroundJob(stepId: string, token: string, jobId: string | null) {
        const rows = await db.update(pipelineRunSteps).set({backgroundRemovalJobId: jobId, updatedAt: sql`CURRENT_TIMESTAMP`}).where(liveClaim(stepId, token)).returning({id: pipelineRunSteps.id})
        if (!rows.length) throw createError({statusCode: 409, statusMessage: 'Pipeline execution ownership expired'})
    }
    async function cancel(id: string) {
        await db.transaction(async tx => {await activeActor(tx); await requireRun(id, tx, true)
            await tx.update(pipelineRuns).set({cancelRequested: true, status: 'cancelled', completedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(pipelineRuns.id, id), runScope()))
            await tx.update(pipelineRunSteps).set({status: 'cancelled', claimToken: null, leaseExpiresAt: null, completedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`})
                .where(and(eq(pipelineRunSteps.runId, id), stepScope(), eq(pipelineRunSteps.active, true), inArray(pipelineRunSteps.status, ['queued', 'awaiting-price'])))
        })
        return {run: await detail(id)}
    }
    async function retry(id: string, raw: unknown) {
        const parsed = RetryPipelineRunSchema.safeParse(raw); if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid pipeline request'})
        await db.transaction(async tx => {
            await activeActor(tx); const run = await requireRun(id, tx, true), steps = await allSteps(id, tx)
            if (steps.some(step => step.status === 'running' || step.status === 'awaiting-price')) throw createError({statusCode: 409, statusMessage: 'Wait for running steps and exact prices before retrying'})
            const selected = steps.filter(step => parsed.data.stepIds.includes(step.id))
            if (selected.length !== new Set(parsed.data.stepIds).size || selected.some(step => !['failed', 'skipped', 'interrupted', 'cancelled'].includes(step.status))) invalid('Choose failed or interrupted steps from this run')
            if (selected.some(step => step.providerStartedAt) && !parsed.data.confirmPossibleCharge) throw createError({statusCode: 409, statusMessage: 'Confirm that a retry makes a new call and may incur an additional charge'})
            const affected = new Set(selected.map(step => step.id))
            for (const step of selected) {
                const descendants = new Set<string>([step.nodeId]); let changed = true
                while (changed) {changed = false; for (const edge of run.definition.edges) if (descendants.has(edge.source) && !descendants.has(edge.target)) {descendants.add(edge.target); changed = true}}
                for (const sibling of steps.filter(value => value.itemId === step.itemId && descendants.has(value.nodeId))) affected.add(sibling.id)
            }
            for (const step of steps.filter(value => affected.has(value.id))) {
                if (step.attempt >= 5) throw createError({statusCode: 409, statusMessage: 'This step reached its retry limit; start a new run'})
                await tx.update(pipelineRunSteps).set({active: false, updatedAt: sql`CURRENT_TIMESTAMP`}).where(eq(pipelineRunSteps.id, step.id))
                await tx.insert(pipelineRunSteps).values({id: randomUUID(), runId: id, itemId: step.itemId, organizationId: actor.organizationId, userId: actor.userId,
                    nodeId: step.nodeId, type: step.type, attempt: step.attempt + 1})
            }
            await tx.update(pipelineRuns).set({cancelRequested: false, status: 'queued', completedAt: null, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(pipelineRuns.id, id), runScope()))
        })
        await notify(id)
        return {run: await detail(id)}
    }
    async function publishPreparation<T>(stepId: string, token: string, publish: (tx: PipelineTransaction) => Promise<T>, sourceUrls: string[] = []): Promise<T> {
        return db.transaction(async tx => {
            await lockPublicationAccounts(tx, sourceUrls)
            const [known] = await tx.select({runId: pipelineRunSteps.runId}).from(pipelineRunSteps).where(and(eq(pipelineRunSteps.id, stepId), stepScope())).limit(1)
            if (!known) throw createError({statusCode: 409, statusMessage: 'Pipeline execution ownership expired'})
            const run = await requireRun(known.runId, tx, true)
            const [step] = await tx.select().from(pipelineRunSteps).where(liveClaim(stepId, token)).for('update').limit(1)
            if (!step || run.cancelRequested) throw createError({statusCode: 409, statusMessage: 'Pipeline execution was cancelled'})
            await assertPeopleSources(getPipelineExecutionNodes(run.definition, step.nodeId), tx, true)
            return publish(tx)
        })
    }
    async function notify(id: string) {
        await db.execute(sql`SELECT pg_notify('pipeline_run_ready', ${id})`).catch(() => console.error('Pipeline wake notification is temporarily unavailable.'))
    }
    async function wake(id: string) {
        await db.transaction(async tx => {await activeActor(tx); const run = await requireRun(id, tx, true)
            if (!run.cancelRequested && liveStatuses.includes(run.status)) await tx.update(pipelineRuns).set({nextAttemptAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(pipelineRuns.id, id), runScope()))})
        await notify(id)
        return {run: await detail(id)}
    }
    async function schedule(id: string, waitMs: number) {
        await db.update(pipelineRuns).set({nextAttemptAt: sql`CURRENT_TIMESTAMP + (${Math.max(0, Math.min(900_000, waitMs))} * interval '1 millisecond')`})
            .where(and(eq(pipelineRuns.id, id), runScope()))
    }
    async function registerProcessed(tx: PipelineTransaction, stepId: string, image: {outputAssetId: string; outputUrl: string}) {
        await tx.insert(pipelineStepOutputs).values({id: randomUUID(), stepId, organizationId: actor.organizationId, userId: actor.userId, ...image})
    }
    return {db, storage, list, get, create, update, remove, start, detail, listRuns, requireRun, claim, heartbeat, providerStarted, finish, setBackgroundJob,
        cancel, retry, wake, schedule, notify, publishPreparation, imageValue, visibleValue, generationRows, registerProcessed, reconcileSteps, synchronize, assertPeopleNodeSources}
}
