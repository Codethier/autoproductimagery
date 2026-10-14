import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {and, eq, sql} from 'drizzle-orm'
import sharp from 'sharp'
import {PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand} from '@aws-sdk/client-s3'
import {organizations, users, assets, pipelines, pipelineRuns, pipelineRunSteps, pipelineStepOutputs, systemPrompt, accountGenerationCharges} from '../server/db/schema.ts'
import {createS3ImageStorage, type ImageStorageCommand} from '../server/utils/useFS.ts'
import {useUserFS} from '../server/utils/useUserFS.ts'
import {createPipelineRepository, pipelineRequestError, safePipelineError} from '../server/utils/pipelineRepository.ts'
import {createPipelineExecutor, hasPendingPipelineWorkerWork} from '../server/utils/pipelineRunner.ts'
import {createPeopleRepository} from '../server/utils/peopleRepository.ts'
import {useDB} from '../server/utils/useDB.ts'
import {createAccountBilling} from '../server/utils/accountBilling.ts'
import {createBackgroundRemovalRepository} from '../server/utils/backgroundRemovalJobs.ts'
import {createBackgroundRemovalRunner} from '../server/utils/backgroundRemovalRunner.ts'
import {getBackgroundRemovalModel} from '../schemas/background-removal-models.ts'
import {createPipelineNode, RerunPipelineRunSchema, type PipelineDefinition, type PipelineNode, type PipelineRunItemDTO} from '../schemas/pipelines.ts'
import {getImageModelProfile, createDefaultSettings, generationOutputCount} from '../schemas/image-generation.ts'
import {PromptEnhancerConfigSchema} from '../schemas/pipeline-text-models.ts'
import {CREDIT_EXHAUSTED_CODE, CREDIT_EXHAUSTED_MESSAGE} from '../schemas/account-billing.ts'
import {processLocalPipelineImage} from '../server/utils/pipelineImageProcessing.ts'
import {publicGeneration} from '../server/utils/generationVisibility.ts'
import type {AuthContext} from '../server/utils/accountSession.ts'
import type {useGateway, PipelineTextRequest} from '../server/utils/useGateway.ts'
import type {runAccountImageGeneration} from '../server/utils/imageGenerationService.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const runtimeConfig = {AiGatewayApiKey: 'invalid-test-key-no-paid-calls'}
type Database = ReturnType<typeof drizzle>
type Fixture = {db: Database; pool: Pool; a: AuthContext; b: AuthContext; stranger: AuthContext;
    raw: ReturnType<typeof createS3ImageStorage>; objects: Map<string, Buffer>; bytes: Buffer}
async function fixture(work: (value: Fixture) => Promise<void>) {
    const schema = `pipeline_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 1})
    const pool = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 5, options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID(), otherOrg = randomUUID()
        const a: AuthContext = {organizationId: org, userId: randomUUID(), username: 'a', displayName: 'A', role: 'owner', organizationName: 'Fixture', isBootstrapOwner: false, authVersion: 1}
        const b: AuthContext = {...a, userId: randomUUID(), username: 'b', displayName: 'B', role: 'user'}
        const stranger: AuthContext = {...a, organizationId: otherOrg, userId: randomUUID(), username: 'stranger'}
        await db.insert(organizations).values([{id: org, name: 'Fixture'}, {id: otherOrg, name: 'Other'}])
        await db.insert(users).values([a,b,stranger].map(actor => ({id: actor.userId, organizationId: actor.organizationId, username: actor.username,
            normalizedUsername: actor.username, displayName: actor.displayName, role: actor.role, passwordHash: 'unused-test'})))
        const objects = new Map<string, Buffer>()
        const raw = createS3ImageStorage({bucket: 'local-test', prefix: 'images', client: {async send(command: ImageStorageCommand) {
            if (command instanceof PutObjectCommand) {objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array)); return {}}
            if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
                const bytes = objects.get(command.input.Key!)
                if (!bytes) throw Object.assign(new Error('private diagnostic'), {name: 'NoSuchKey', $metadata: {httpStatusCode: 404}})
                return command instanceof HeadObjectCommand ? {ContentLength: bytes.length} : {Body: Readable.from([bytes]), ContentLength: bytes.length}
            }
            if (command instanceof DeleteObjectCommand) {objects.delete(command.input.Key!); return {}}
            return {Contents: [], CommonPrefixes: [], IsTruncated: false}
        }}})
        const bytes = await sharp({create: {width: 24, height: 16, channels: 4, background: {r: 160, g: 30, b: 70, alpha: 0.6}}}).png().toBuffer()
        await work({db,pool,a,b,stranger,raw,objects,bytes})
    } finally {await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()}
}
const graph = (nodes: PipelineNode[], links: Array<[string,string,string?]>): PipelineDefinition => ({version:1,nodes,
    edges:links.map(([source,target,targetPort],i) => ({id:`e${i}`,source,sourcePort:['text-input','static-text','prompt-concatenator','llm','prompt-enhancer','describe-image'].includes(nodes.find(n=>n.id===source)!.type)?'text':'image',target,targetPort:targetPort??(nodes.find(n=>n.id===target)!.type==='output'?'media':'image')}))})
const upload = (data:Buffer) => ({name:'files' as const,filename:'product.png',type:'image/png',data})
async function saveStart(repo:ReturnType<typeof createPipelineRepository>, definition:PipelineDefinition, inputs:string[] = [], extra:Record<string,unknown>={}) {
    const {pipeline}=await repo.create({name:'Fixture pipeline',description:'',definition})
    const {run}=await repo.start(pipeline.id,{revision:pipeline.revision,idempotencyKey:randomUUID(),inputImages:inputs,...(inputs.length?{batchInputNodeId:'input'}:{}),inputs:{},...extra})
    return {pipeline,run}
}
const noGateway = {async getGenerationBilling(){return undefined}} as unknown as Awaited<ReturnType<typeof useGateway>>

test('pipeline acceptance preserves committed jobs and idempotency when a sleeping runner cannot acknowledge its wake', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db)
    let wakes = 0
    const repo = createPipelineRepository(f.a, f.db, {storage, workerWake: async () => {
        wakes++
        // A separate database connection must already see the accepted row.
        const result = await f.pool.query('SELECT id FROM pipeline_run WHERE user_id = $1', [f.a.userId])
        assert.equal(result.rowCount, 1)
        throw Error('private wake transport diagnostic')
    }})
    const text = createPipelineNode('static-text', 'text'), output = createPipelineNode('output', 'output')
    text.config.text = 'Free synthetic local workflow'
    const {pipeline} = await repo.create({name: 'Wake fixture', description: '', definition: graph([text, output], [['text', 'output', 'media']])})
    const request = {revision: pipeline.revision, idempotencyKey: randomUUID(), inputImages: [], inputs: {}}
    const accepted = await repo.start(pipeline.id, request)
    assert.equal(accepted.workerWake, 'unavailable'); assert.equal(accepted.run.status, 'queued')
    const repeated = await repo.start(pipeline.id, request)
    assert.equal(repeated.workerWake, 'unavailable'); assert.equal(repeated.run.id, accepted.run.id)
    assert.deepEqual(repeated.run.items.map(item => item.steps.map(step => step.id)), accepted.run.items.map(item => item.steps.map(step => step.id)))
    assert.equal(wakes, 2)
    const [count] = await f.db.select({id: pipelineRuns.id}).from(pipelineRuns)
    assert.equal(count!.id, accepted.run.id)
}))

test('worker idle detection includes unfinished future-scheduled runs and stops after completion or owner disablement', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db), repo = createPipelineRepository(f.a, f.db, {storage})
    const text = createPipelineNode('static-text', 'text'), output = createPipelineNode('output', 'output')
    text.config.text = 'Known-free local workflow'
    assert.equal(await hasPendingPipelineWorkerWork(f.db), false)
    const {run} = await saveStart(repo, graph([text, output], [['text', 'output', 'media']]))
    await f.db.update(pipelineRuns).set({nextAttemptAt: sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`}).where(eq(pipelineRuns.id, run.id))
    assert.equal(await hasPendingPipelineWorkerWork(f.db), true)
    await f.db.update(users).set({disabledAt: new Date().toISOString()}).where(eq(users.id, f.a.userId))
    assert.equal(await hasPendingPipelineWorkerWork(f.db), false)
    await f.db.update(users).set({disabledAt: null}).where(eq(users.id, f.a.userId))
    assert.equal(await hasPendingPipelineWorkerWork(f.db), true)
    await drain(createPipelineExecutor(f.a, repo, {runtimeConfig, gateway: noGateway}), run.id)
    assert.equal(await hasPendingPipelineWorkerWork(f.db), false)
}))

test('a cancelled or disabled-owner accepted live claim prevents idle sleep without making its paid fence replayable', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db), repo = createPipelineRepository(f.a, f.db, {storage})
    const text = createPipelineNode('static-text', 'text'), output = createPipelineNode('output', 'output')
    text.config.text = 'Free synthetic claim'
    const {run} = await saveStart(repo, graph([text, output], [['text', 'output', 'media']]))
    const claim = await repo.claim(run.id)
    assert.ok(claim)
    await repo.providerStarted(claim.step.id, claim.token, randomUUID())
    await repo.cancel(run.id)
    await f.db.update(users).set({disabledAt: new Date().toISOString()}).where(eq(users.id, f.a.userId))
    assert.equal(await hasPendingPipelineWorkerWork(f.db), true)
    const [live] = await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.id, claim.step.id))
    assert.equal(live!.status, 'running'); assert.ok(live!.providerStartedAt)
    await f.db.update(pipelineRunSteps).set({leaseExpiresAt: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'`}).where(eq(pipelineRunSteps.id, claim.step.id))
    assert.equal(await hasPendingPipelineWorkerWork(f.db), false)
    const [expired] = await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.id, claim.step.id))
    assert.equal(expired!.status, 'running'); assert.equal(expired!.providerStartedAt, live!.providerStartedAt)
    assert.equal(expired!.claimToken, live!.claimToken)
}))
async function drain(executor:ReturnType<typeof createPipelineExecutor>, runId:string, limit=40) {
    let value=await executor.get(runId)
    for(let i=0;i<limit&&['queued','running','awaiting-price'].includes(value.run.status);i++)value=await executor.advance(runId)
    return value.run
}
const rerunBody = (item: PipelineRunItemDTO, confirmPossibleCharge = false) => ({itemIds: [item.id], expectedStepIds: item.steps.map(step => step.id), confirmPossibleCharge})

test('job rerun requests are strict, bounded and reject duplicate or missing revision fences',()=>{
    const itemId=randomUUID(),stepId=randomUUID()
    assert.equal(RerunPipelineRunSchema.safeParse({itemIds:[itemId],expectedStepIds:[stepId]}).success,true)
    for(const body of [
        {itemIds:[itemId]}, {itemIds:[],expectedStepIds:[stepId]}, {itemIds:[itemId],expectedStepIds:[]},
        {itemIds:[itemId,itemId],expectedStepIds:[stepId]}, {itemIds:[itemId],expectedStepIds:[stepId,stepId]},
        {itemIds:Array.from({length:51},()=>randomUUID()),expectedStepIds:[stepId]},
        {itemIds:[itemId],expectedStepIds:Array.from({length:1201},()=>randomUUID())},
        {itemIds:[itemId],expectedStepIds:[stepId],inputImages:['/new.png']},
        {itemIds:['other-user'],expectedStepIds:[stepId]},
    ]) assert.equal(RerunPipelineRunSchema.safeParse(body).success,false)
})

test('rerun replaces only the chosen job with immutable original inputs/settings and keeps previous outputs',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const originals=await Promise.all([fs.saveUpload('/',upload(f.bytes)),fs.saveUpload('/',upload(f.bytes))])
    const resize=createPipelineNode('resize','resize');resize.config={width:32,height:32,fit:'contain',background:'transparent'}
    const definition=graph([createPipelineNode('image-input','input'),resize,createPipelineNode('output','out')],[['input','resize'],['resize','out']])
    const {pipeline,run}=await saveStart(repo,definition,originals.map(image=>image.url)),executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig})
    const first=await drain(executor,run.id),previous=first.items[0]!,sibling=first.items[1]!
    const oldOutput=previous.steps.at(-1)!.value!.images[0]!,oldBytes=(await fs.getImageFile(oldOutput.url)).buffer
    const historical=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.itemId,previous.id))
    await repo.update(pipeline.id,{revision:1,name:'Changed after run',definition:{...definition,nodes:definition.nodes.map(node=>node.type==='resize'?{...node,config:{...node.config,width:80,height:80}}:node)}})
    await f.db.update(pipelineRuns).set({nextAttemptAt:sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`}).where(eq(pipelineRuns.id,run.id))
    const queued=(await repo.rerun(run.id,rerunBody(previous))).run
    assert.equal(queued.id,first.id);assert.equal(queued.revision,1);assert.equal(queued.items[0]!.id,previous.id);assert.equal(queued.items[0]!.inputUrl,originals[0]!.url)
    assert.deepEqual(queued.items[1],sibling);assert.equal(queued.status,'queued')
    assert.ok(queued.items[0]!.steps.every(step=>step.attempt===2&&step.status==='queued'&&step.value===null&&!previous.steps.some(old=>old.id===step.id)))
    const [currentRun]=await f.db.select().from(pipelineRuns).where(eq(pipelineRuns.id,run.id));assert.ok(Date.parse(currentRun!.nextAttemptAt)<=Date.now());assert.deepEqual(currentRun!.definition,definition)
    for(const old of historical){const [kept]=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.id,old.id));assert.deepEqual({...kept,active:old.active,updatedAt:old.updatedAt},old);assert.equal(kept!.active,false)}
    const second=await drain(executor,run.id),newOutput=second.items[0]!.steps.at(-1)!.value!.images[0]!
    assert.equal(newOutput.width,32);assert.equal(newOutput.height,32);assert.notEqual(newOutput.url,oldOutput.url);assert.deepEqual(second.items[1],sibling)
    assert.deepEqual((await fs.getImageFile(oldOutput.url)).buffer,oldBytes);assert.deepEqual((await fs.getImageFile(originals[0]!.url)).buffer,f.bytes)
    assert.equal((await f.db.select().from(pipelineStepOutputs)).length,3)
}))

test('concurrent and stale rerun clicks admit one fresh attempt, including after its fast completion',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');text.config.text='Same immutable prompt'
    const {run}=await saveStart(repo,graph([text,createPipelineNode('output','out')],[['text','out']]))
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}),first=await drain(executor,run.id),body=rerunBody(first.items[0]!)
    const results=await Promise.allSettled([repo.rerun(run.id,body),repo.rerun(run.id,body)])
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
    const refused=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.equal(refused.reason.statusCode,409)
    assert.equal((await f.db.select().from(pipelineRunSteps)).length,4)
    const second=await drain(executor,run.id);assert.equal(second.status,'succeeded');assert.equal(second.items[0]!.steps.at(-1)!.value!.text,'Same immutable prompt')
    await assert.rejects(repo.rerun(run.id,body),(error:any)=>error.statusCode===409)
    assert.equal((await f.db.select().from(pipelineRunSteps)).length,4)
}))

test('paid reruns require confirmation, preserve all prices/history and use a new charge batch',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    await f.db.update(users).set({creditBalanceUnits:'1000000000000'}).where(eq(users.id,f.a.userId))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),generateNode('g'),createPipelineNode('output','out')],[['input','g'],['g','out']]),[original.url])
    const calls={value:0,batches:[] as string[]},executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate:fakeGeneration(f,fs,'gateway',calls)}),first=await drain(executor,run.id)
    const history=await f.db.select().from(systemPrompt),charges=await f.db.select().from(accountGenerationCharges),oldOutput=first.items[0]!.steps.at(-1)!.value!.images[0]!
    await assert.rejects(repo.rerun(run.id,rerunBody(first.items[0]!)),(error:any)=>error.statusCode===409)
    assert.equal((await f.db.select().from(pipelineRunSteps)).length,3)
    await repo.rerun(run.id,rerunBody(first.items[0]!,true));const second=await drain(executor,run.id)
    assert.equal(calls.value,2);assert.equal(new Set(calls.batches).size,2);assert.equal(second.summary.confirmedCostUsd,'0.500000000000');assert.equal(second.summary.outstandingCount,0)
    assert.equal((await createAccountBilling(f.db).balanceFor(f.a)).actualBalanceUsd,'0.500000000000')
    assert.deepEqual((await f.db.select().from(systemPrompt).where(eq(systemPrompt.id,history[0]!.id)))[0],history[0])
    assert.deepEqual((await f.db.select().from(accountGenerationCharges).where(eq(accountGenerationCharges.generationId,charges[0]!.generationId)))[0],charges[0])
    assert.deepEqual((await fs.getImageFile(oldOutput.url)).buffer,f.bytes)
    assert.notEqual(second.items[0]!.steps.find(step=>step.nodeId==='g')!.generationIds[0],history[0]!.id)
    assert.equal((await repo.listRuns({limit:20,search:''})).runs[0]!.summary.confirmedCostUsd,'0.500000000000')
}))

test('zero-credit reruns refuse atomically with the popup code, while local reruns remain free and scoped',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),generateNode('g'),createPipelineNode('output','out')],[['input','g'],['g','out']]),[original.url])
    const calls={value:0,batches:[] as string[]},first=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate:fakeGeneration(f,fs,'gateway',calls)}),run.id)
    const before=await f.db.select().from(pipelineRunSteps),beforeRun=await repo.requireRun(run.id),body=rerunBody(first.items[0]!,true)
    for(const actor of [f.b,f.stranger]) await assert.rejects(createPipelineRepository(actor,f.db,{storage:await useUserFS(actor,f.raw,f.db)}).rerun(run.id,body),(error:any)=>error.statusCode===404)
    for(const creditBalanceUnits of ['0','-1']){
        await f.db.update(users).set({creditBalanceUnits}).where(eq(users.id,f.a.userId))
        await assert.rejects(repo.rerun(run.id,body),(error:any)=>{assert.equal(error.statusCode,402);assert.deepEqual(error.data,{code:CREDIT_EXHAUSTED_CODE});return true})
        assert.deepEqual(await f.db.select().from(pipelineRunSteps),before);assert.deepEqual(await repo.requireRun(run.id),beforeRun)
    }
    const local=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('output','out')],[['input','out']]),[original.url])
    const localExecutor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}),done=await drain(localExecutor,local.run.id)
    assert.equal((await repo.rerun(local.run.id,rerunBody(done.items[0]!))).run.status,'queued')
    const completed=await drain(localExecutor,local.run.id);assert.equal(completed.status,'succeeded');assert.equal((await createAccountBilling(f.db).balanceFor(f.a)).actualBalanceUsd,'-0.000000000001')
    await f.db.update(users).set({authVersion:2}).where(eq(users.id,f.a.userId))
    await assert.rejects(repo.rerun(local.run.id,rerunBody(completed.items[0]!)),(error:any)=>error.statusCode===401)
    await f.db.update(users).set({authVersion:1,disabledAt:sql`CURRENT_TIMESTAMP`}).where(eq(users.id,f.a.userId))
    await assert.rejects(repo.rerun(local.run.id,rerunBody(completed.items[0]!)),(error:any)=>error.statusCode===401)
    assert.equal(calls.value,1)
}))

test('one completed job reruns while a sibling owns a live claim without altering its provider fence or outputs',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('resize','resize'),createPipelineNode('output','out')],[['input','resize'],['resize','out']]),[original.url,original.url])
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig})
    for(let i=0;i<3;i++)await executor.advance(run.id)
    const first=await repo.detail(run.id);assert.equal(first.items[0]!.status,'succeeded');assert.equal(first.items[1]!.status,'queued')
    const claim=await repo.claim(run.id);assert.ok(claim);assert.equal(claim.step.itemId,first.items[1]!.id)
    await repo.providerStarted(claim.step.id,claim.token,randomUUID())
    const siblingBefore=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.itemId,first.items[1]!.id))
    const queued=(await repo.rerun(run.id,rerunBody(first.items[0]!))).run
    assert.equal(queued.status,'running');assert.equal(queued.items[0]!.status,'queued');assert.equal(queued.items[1]!.status,'running')
    assert.deepEqual(await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.itemId,first.items[1]!.id)),siblingBefore)
    assert.equal(await repo.claim(run.id),null,'the one live sibling claim prevents overlapping execution in this run')
    assert.equal(await repo.finish(claim.step.id,claim.token,'succeeded',{images:[await repo.imageValue(original.url)],text:null}),true)
    const done=await drain(executor,run.id);assert.equal(done.status,'succeeded');assert.ok(done.items[0]!.steps.every(step=>step.attempt===2));assert.ok(done.items[1]!.steps.every(step=>step.attempt===1))
}))

test('a sibling provider-start fence overlaps a held rerun transaction without inverting account/run locks',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),generateNode('g'),createPipelineNode('output','out')],[['input','g'],['g','out']]),[original.url,original.url])
    const calls={value:0,batches:[] as string[]},executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate:fakeGeneration(f,fs,'gateway',calls)})
    for(let i=0;i<4;i++)await executor.advance(run.id)
    const current=await repo.detail(run.id);assert.equal(current.items[0]!.status,'succeeded')
    const claim=await repo.claim(run.id);assert.ok(claim);assert.equal(claim.step.nodeId,'g');assert.equal(claim.step.itemId,current.items[1]!.id)
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),realAssert=fs.assertReadableImages.bind(fs)
    fs.assertReadableImages=async paths=>{await realAssert(paths);entered.resolve();await release.promise}
    const rerunning=repo.rerun(run.id,rerunBody(current.items[0]!,true));await entered.promise
    let fenced=false;const batchId=randomUUID(),fencing=repo.providerStarted(claim.step.id,claim.token,batchId).then(()=>{fenced=true})
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(fenced,false,'the provider fence waits on the account acquired before the rerun run lock')
    release.resolve();const [result]=await Promise.all([rerunning,fencing])
    assert.equal(result.run.items[0]!.status,'queued');assert.equal(result.run.status,'running')
    const [sibling]=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.id,claim.step.id))
    assert.equal(sibling!.active,true);assert.equal(sibling!.status,'running');assert.equal(sibling!.claimToken,claim.token);assert.equal(sibling!.batchId,batchId);assert.ok(sibling!.providerStartedAt)
    assert.equal(await repo.finish(claim.step.id,claim.token,'succeeded',{images:[await repo.imageValue(original.url)],text:null}),true)
    assert.equal(calls.value,1,'no paid provider is contacted by requeue or the synthetic fence')
}))

test('selected unfinished/unpriced jobs cannot rerun and a draining cancellation never revives another claim',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('output','out')],[['input','out']]),[original.url,original.url])
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig});await executor.advance(run.id);await executor.advance(run.id)
    const first=await repo.detail(run.id)
    await assert.rejects(repo.rerun(run.id,rerunBody(first.items[1]!)),(error:any)=>error.statusCode===400)
    const claim=await repo.claim(run.id);assert.ok(claim)
    await repo.finish(claim.step.id,claim.token,'awaiting-price',null)
    const held=await repo.detail(run.id);assert.equal(held.items[1]!.status,'awaiting-price')
    await assert.rejects(repo.rerun(run.id,rerunBody(held.items[1]!)),(error:any)=>error.statusCode===400)
    const repeated=(await repo.rerun(run.id,rerunBody(first.items[0]!))).run;assert.equal(repeated.status,'awaiting-price')
    assert.equal((await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.id,claim.step.id)))[0]!.status,'awaiting-price')
    await f.db.update(pipelineRunSteps).set({status:'succeeded',value:{images:[await repo.imageValue(original.url)],text:null},completedAt:sql`CURRENT_TIMESTAMP`}).where(eq(pipelineRunSteps.id,claim.step.id))
    const done=await drain(executor,run.id);assert.equal(done.status,'succeeded')
    await repo.rerun(run.id,rerunBody(done.items[1]!));const draining=await repo.claim(run.id);assert.ok(draining)
    await repo.cancel(run.id)
    const snapshot=await f.db.select().from(pipelineRunSteps)
    const cancelled=await repo.detail(run.id)
    await assert.rejects(repo.rerun(run.id,rerunBody(cancelled.items[0]!)),(error:any)=>error.statusCode===409)
    assert.deepEqual(await f.db.select().from(pipelineRunSteps),snapshot);assert.equal((await repo.requireRun(run.id)).cancelRequested,true)
    await repo.finish(draining.step.id,draining.token,'cancelled',null)
    const terminal=await repo.detail(run.id)
    const restored=(await repo.rerun(run.id,rerunBody(terminal.items[0]!))).run;assert.equal(restored.cancelRequested,false);assert.equal(restored.items[1]!.status,'cancelled')
}))

test('rerun authorization checks fresh shared sources at admission and again after requeue',integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs}),original=await sourceFS.saveUpload('/',upload(f.bytes))
    await sourceFS.share(original.id!,f.b.userId,'view')
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('output','out')],[['input','out']]),[original.url])
    const executor=createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig}),first=await drain(executor,run.id),before=await f.db.select().from(pipelineRunSteps)
    await sourceFS.revoke(original.id!,f.b.userId)
    await assert.rejects(repo.rerun(run.id,rerunBody(first.items[0]!)),(error:any)=>error.statusCode===404)
    assert.deepEqual(await f.db.select().from(pipelineRunSteps),before)
    await sourceFS.share(original.id!,f.b.userId,'view');await repo.rerun(run.id,rerunBody(first.items[0]!));await sourceFS.revoke(original.id!,f.b.userId)
    const failed=await drain(executor,run.id);assert.equal(failed.items[0]!.steps[0]!.error?.code,'SOURCE_UNAVAILABLE');assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

test('People reruns cannot bypass a revoked profile through an independent file grant',integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs})
    const person=(await people.create({name:'Shared reference'})).person,photo=await sourceFS.saveUpload('/',upload(f.bytes));await people.addPhotos(person.id,{urls:[photo.url]});await people.share(person.id,{recipientUserId:f.b.userId});await sourceFS.share(photo.id!,f.b.userId,'view')
    const input=createPipelineNode('people-input','people');input.config.images=[photo.url]
    const {run}=await saveStart(repo,graph([input,createPipelineNode('output','out')],[['people','out']]))
    const executor=createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig}),first=await drain(executor,run.id),before=await f.db.select().from(pipelineRunSteps)
    await people.revoke(person.id,f.b.userId);assert.equal((await fs.assetByUrl(photo.url)).id,photo.id)
    await assert.rejects(repo.rerun(run.id,rerunBody(first.items[0]!)),(error:any)=>error.statusCode===404);assert.deepEqual(await f.db.select().from(pipelineRunSteps),before)
    await people.share(person.id,{recipientUserId:f.b.userId});await repo.rerun(run.id,rerunBody(first.items[0]!));await people.removePhoto(person.id,photo.id!)
    const failed=await drain(executor,run.id);assert.equal(failed.items[0]!.steps[0]!.error?.code,'SOURCE_UNAVAILABLE');assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

test('reruns retain a node-only target and immutable input text after the saved pipeline is removed, with a five-attempt cap',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('text-input','text');text.config.required=true
    const {pipeline,run}=await saveStart(repo,graph([text,createPipelineNode('output','out'),createPipelineNode('image-input','unused')],[['text','out']]),[],{inputs:{text:'The original prompt'},targetNodeId:'text'})
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig});let current=await drain(executor,run.id)
    await repo.remove(pipeline.id)
    for(let attempt=2;attempt<=5;attempt++){
        await repo.rerun(run.id,rerunBody(current.items[0]!));current=await drain(executor,run.id)
        assert.equal(current.targetNodeId,'text');assert.equal(current.items[0]!.steps.length,1);assert.equal(current.items[0]!.steps[0]!.attempt,attempt);assert.equal(current.items[0]!.steps[0]!.value!.text,'The original prompt')
    }
    const before=await f.db.select().from(pipelineRunSteps)
    await assert.rejects(repo.rerun(run.id,rerunBody(current.items[0]!)),(error:any)=>error.statusCode===409&&error.statusMessage.includes('five-attempt'))
    assert.deepEqual(await f.db.select().from(pipelineRunSteps),before);assert.equal(before.length,5)
}))

test('requeued completed runs obey personal and global pipeline queue admission limits',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');text.config.text='Local bounded work'
    const definition=graph([text,createPipelineNode('output','out')],[['text','out']]),{pipeline,run}=await saveStart(repo,definition)
    const completed=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}),run.id),body=rerunBody(completed.items[0]!)
    const live=await Promise.all(Array.from({length:3},()=>repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{}})))
    const before=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id))
    await assert.rejects(repo.rerun(run.id,body),(error:any)=>error.statusCode===429)
    assert.deepEqual(await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id)),before)
    for(const value of live)await repo.cancel(value.run.id)
    const bRepo=createPipelineRepository(f.b,f.db,{storage:await useUserFS(f.b,f.raw,f.db)}),bPipeline=(await bRepo.create({name:'Other account live runs',definition})).pipeline
    await f.db.insert(pipelineRuns).values(Array.from({length:20},()=>({id:randomUUID(),pipelineId:bPipeline.id,organizationId:f.b.organizationId,userId:f.b.userId,name:bPipeline.name,revision:1,definition,inputs:{},idempotencyKey:randomUUID()})))
    await assert.rejects(repo.rerun(run.id,body),(error:any)=>error.statusCode===429)
    assert.deepEqual(await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id)),before)
}))

test('pipeline credit refusals keep only the canonical public discriminator across HTTP and persisted step errors',()=>{
    const privateError={statusCode:402,statusMessage:'private provider detail',data:{code:CREDIT_EXHAUSTED_CODE,credential:'private-test-diagnostic'}}
    assert.throws(()=>pipelineRequestError(privateError),(error:any)=>{
        assert.equal(error.statusCode,402);assert.equal(error.statusMessage,CREDIT_EXHAUSTED_MESSAGE)
        assert.deepEqual(error.data,{code:CREDIT_EXHAUSTED_CODE});return true
    })
    assert.deepEqual(safePipelineError(privateError),{code:CREDIT_EXHAUSTED_CODE,message:CREDIT_EXHAUSTED_MESSAGE,retryable:true})
    assert.throws(()=>pipelineRequestError({statusCode:409,statusMessage:'Wait for current prices',data:{code:'private'}}),(error:any)=>error.statusCode===409&&error.data===undefined)
})

test('zero and overdrawn finite accounts cannot start any paid pipeline type and create no run or pending charge',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    for(const type of ['generate-image','expand','translate','upscale','describe-image','prompt-enhancer','llm'] as const){
        const node=createPipelineNode(type,'paid')
        if(node.type==='generate-image')node.config.prompt='Keep this product'
        if(node.type==='upscale')node.config.mode='ai'
        if(node.type==='prompt-enhancer'||node.type==='llm')node.config.prompt='Improve this product image prompt'
        const needsImage=!['prompt-enhancer','llm'].includes(type)
        const definition=graph([...(needsImage?[createPipelineNode('image-input','input')]:[]),node,createPipelineNode('output','out')],
            [...(needsImage?[['input','paid'] as [string,string]]:[]),['paid','out']])
        const {pipeline}=await repo.create({name:`Paid ${type}`,definition})
        for(const creditBalanceUnits of ['0','-1']){
            await f.db.update(users).set({creditBalanceUnits}).where(eq(users.id,f.a.userId))
            await assert.rejects(repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{},...(needsImage?{inputImages:[original.url],batchInputNodeId:'input'}:{})}),(error:any)=>{
                assert.equal(error.statusCode,402);assert.deepEqual(error.data,{code:CREDIT_EXHAUSTED_CODE});return true
            })
        }
    }
    assert.equal((await f.db.select().from(pipelineRuns)).length,0)
    assert.equal((await f.db.select().from(pipelineRunSteps)).length,0)
    assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

test('a fresh image or text worker wave rechecks depleted credit after run admission without starting a paid call',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const calls={value:0,batches:[] as string[]}
    let textCalls=0
    const gateway={async getGenerationBilling(){return undefined},async generatePipelineText(){textCalls++;throw new Error('No paid text call may start')}} as unknown as Awaited<ReturnType<typeof useGateway>>
    for(const type of ['generate-image','prompt-enhancer'] as const){
        await f.db.update(users).set({creditBalanceUnits:'1000000000000'}).where(eq(users.id,f.a.userId))
        const node=type==='generate-image'?generateNode('paid'):createPipelineNode('prompt-enhancer','paid')
        if(node.type==='prompt-enhancer')node.config.prompt='Improve this product prompt'
        const {run}=await saveStart(repo,graph([...(type==='generate-image'?[createPipelineNode('image-input','input')]:[]),node,createPipelineNode('output','out')],
            [...(type==='generate-image'?[['input','paid'] as [string,string]]:[]),['paid','out']]),type==='generate-image'?[original.url]:[])
        await f.db.update(users).set({creditBalanceUnits:'0'}).where(eq(users.id,f.a.userId))
        const done=await drain(createPipelineExecutor(f.a,repo,{gateway,runtimeConfig,coordinationPool:f.pool,generate:fakeGeneration(f,fs,'gateway',calls)}),run.id)
        assert.equal(done.items[0]!.steps.find(step=>step.nodeId==='paid')!.error?.code,CREDIT_EXHAUSTED_CODE)
    }
    assert.equal(calls.value,0);assert.equal(textCalls,0)
    assert.equal((await f.db.select().from(systemPrompt)).length,0)
    assert.ok((await f.db.select().from(pipelineRunSteps)).every(step=>step.providerStartedAt===null))
}))

test('saved pipelines enforce private account scope, revision checks, immutable snapshots and scoped SQL cursors',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const definition=graph([createPipelineNode('static-text','text'),createPipelineNode('output','out')],[['text','out']]);if(definition.nodes[0]!.type==='static-text')definition.nodes[0]!.config.text='First'
    const {pipeline}=await repo.create({name:'Private factory',description:'Fixture',definition})
    for(const actor of [f.b,f.stranger])await assert.rejects(createPipelineRepository(actor,f.db,{storage:await useUserFS(actor,f.raw,f.db)}).get(pipeline.id),(e:{statusCode:number})=>e.statusCode===404)
    const first=await repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{},inputImages:[]})
    await repo.update(pipeline.id,{revision:1,name:'Updated factory',description:'',definition:{...definition,nodes:definition.nodes.map(n=>n.type==='static-text'?{...n,config:{text:'Second'}}:n)}})
    await assert.rejects(repo.update(pipeline.id,{revision:1,name:'Conflict',definition}),(e:{statusCode:number})=>e.statusCode===409)
    assert.equal(first.run.definition.nodes.find(n=>n.type==='static-text')?.config.text,'First')
    const page=await repo.list({limit:1,search:''});await repo.create({name:'Another',description:'',definition})
    const two=await repo.list({limit:1,search:''});assert.ok(two.nextCursor)
    await assert.rejects(createPipelineRepository(f.b,f.db,{storage:await useUserFS(f.b,f.raw,f.db)}).list({limit:1,search:'',cursor:two.nextCursor!}),(e:{statusCode:number})=>e.statusCode===400)
    assert.equal(page.pipelines.length,1)
}))

test('concurrent idempotent starts create one run and node-only runs include only required ancestry',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');if(text.type==='static-text')text.config.text='Hello'
    const definition=graph([text,createPipelineNode('output','out'),createPipelineNode('image-input','unused')],[['text','out']])
    const {pipeline}=await repo.create({name:'Ancestry',definition})
    const body={revision:1,idempotencyKey:randomUUID(),inputs:{},inputImages:[],targetNodeId:'text'}
    const [one,two]=await Promise.all([repo.start(pipeline.id,body),repo.start(pipeline.id,body)])
    assert.equal(one.run.id,two.run.id);assert.equal(one.run.items[0]!.steps.length,1)
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig})
    assert.equal((await drain(executor,one.run.id)).items[0]!.steps[0]!.value?.text,'Hello')
    await assert.rejects(repo.start(pipeline.id,{...body,targetNodeId:'out'}),(e:{statusCode:number})=>e.statusCode===409)
}))

test('multiple input images execute independently through real local transforms and format conversion without changing originals',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const originals=await Promise.all([fs.saveUpload('/',upload(f.bytes)),fs.saveUpload('/',upload(f.bytes))])
    const resize=createPipelineNode('resize','resize');if(resize.type==='resize')resize.config={width:32,height:32,fit:'contain',background:'transparent'}
    const output=createPipelineNode('output','out');if(output.type==='output')output.config={format:'jpeg',quality:85}
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),resize,output],[['input','resize'],['resize','out']]),originals.map(i=>i.url))
    const done=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}),run.id)
    assert.equal(done.status,'succeeded');assert.equal(done.summary.succeeded,2);assert.equal(done.summary.confirmedCostUsd,'0.000000000000')
    for(const item of done.items){const image=item.steps.at(-1)!.value!.images[0]!;const stored=await fs.getImageFile(image.url);assert.equal(stored.mimeType,'image/jpeg');assert.equal(stored.width,32);assert.equal(stored.height,32);assert.equal(image.priceSource,'local-processing')}
    for(const original of originals)assert.deepEqual((await fs.getImageFile(original.url)).buffer,f.bytes)
    assert.equal((await f.db.select().from(pipelineStepOutputs)).length,4)
    await assert.rejects((await useUserFS(f.b,f.raw,f.db)).getImageFile(done.items[0]!.steps.at(-1)!.value!.images[0]!.url),(e:{statusCode:number})=>e.statusCode===404)
}))

test('shared source revocation redacts saved and run projections and blocks queued execution before paid work',integration,async()=>fixture(async f=>{
    const aFS=await useUserFS(f.a,f.raw,f.db),bFS=await useUserFS(f.b,f.raw,f.db)
    const original=await aFS.saveUpload('/',upload(f.bytes));await aFS.share(original.id!,f.b.userId,'view')
    const input=createPipelineNode('image-input','input');if(input.type==='image-input')input.config.defaultImage=original.url
    const repo=createPipelineRepository(f.b,f.db,{storage:bFS});const {pipeline,run}=await saveStart(repo,graph([input,createPipelineNode('output','out')],[['input','out']]))
    await aFS.revoke(original.id!,f.b.userId)
    assert.ok(!JSON.stringify((await repo.get(pipeline.id)).pipeline).includes(original.url))
    const result=await createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig}).advance(run.id)
    assert.equal(result.run.status,'failed');assert.ok(!JSON.stringify(result.run).includes(original.url))
    assert.equal(result.run.items[0]!.steps[0]!.error?.code,'SOURCE_UNAVAILABLE')
    assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

function fakeGeneration(f:Fixture,fs:Awaited<ReturnType<typeof useUserFS>>, billingSource:'gateway'|'estimate', calls:{value:number;batches:string[]}) {
    return (async(actor,request,options={})=>{
        const database=await useDB(f.db,actor),batchId=randomUUID(),profile=getImageModelProfile(request.model)!
        const rows=await database.createPendingGenerations(Array.from({length:generationOutputCount(request.settings)},()=>({prompt:request.prompt,inputImages:request.inputImages,
            modelImages:request.modelImages,requestedModel:request.model,effectiveModel:request.model,batchId,pipelineStepId:options.pipelineStepId,
            generationConfig:{schemaVersion:1,profileVersion:profile.profileVersion,requestedModel:request.model,effectiveModel:request.model,settings:request.settings,storeInputImages:true}})))
        await options.beforeProviderCall?.({batchId,generationIds:rows.map(row=>row.id),inputImage:request.inputImages[0]??null,signal:new AbortController().signal})
        calls.value++;calls.batches.push(batchId)
        for(const row of rows){const saved=await fs.saveGeneratedImage(f.bytes,'image/png');await database.completeGeneration(row.id,{outputImage:saved.url,
            outputMetadata:{mimeType:'image/png',bytes:f.bytes.length,width:24,height:16,warnings:[]},billing:{model:request.model,priceUsd:'0.25',priceSource:billingSource,gatewayGenerationId:`gen_${row.id}`,usageJson:{gatewayBilling:{isByok:false}}},
            log:{model:request.model,prompt:request.prompt,status:'success',batchId}})}
        const result=await Promise.all(rows.map(row=>database.getSystemPrompt(row.id)))
        return {ok:true,obj:result.map(row=>publicGeneration(row!)),batchId,summary:{requested:rows.length,total:rows.length,succeeded:rows.length,failed:0}}
    }) as typeof runAccountImageGeneration
}
const generateNode=(id:string)=>{const node=createPipelineNode('generate-image',id);if(node.type==='generate-image')node.config.prompt='Keep this product';return node}

test('confirmed-price gating blocks downstream work and distinct step batches enforce finite credit after every wave',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    await f.db.update(users).set({creditBalanceUnits:'400000000000'}).where(eq(users.id,f.a.userId))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),generateNode('g1'),generateNode('g2'),generateNode('g3'),createPipelineNode('output','out')],[['input','g1'],['g1','g2'],['g2','g3'],['g3','out']]),[original.url])
    const calls={value:0,batches:[] as string[]};let confirm=false
    const gateway={async getGenerationBilling(id:string){return confirm?{gatewayGenerationId:id,priceSource:'gateway',priceUsd:'0.25',usageJson:{gatewayBilling:{isByok:false}}}:undefined}} as unknown as Awaited<ReturnType<typeof useGateway>>
    const executor=createPipelineExecutor(f.a,repo,{gateway,generate:fakeGeneration(f,fs,'estimate',calls),runtimeConfig})
    await executor.advance(run.id);const first=(await executor.advance(run.id)).run
    assert.equal(calls.value,1);assert.equal(first.status,'awaiting-price');assert.equal(first.items[0]!.steps.find(s=>s.nodeId==='g1')!.value,null)
    await executor.advance(run.id);assert.equal(calls.value,1)
    // Only a real confirmed lookup would unlock in production. This is a local mock.
    confirm=true;await f.pool.query("UPDATE account_generation_charge SET next_check_at=CURRENT_TIMESTAMP - INTERVAL '1 second'")
    await executor.advance(run.id);assert.equal(calls.value,2)
    await f.pool.query("UPDATE account_generation_charge SET next_check_at=CURRENT_TIMESTAMP - INTERVAL '1 second'")
    const final=await executor.advance(run.id)
    assert.equal(calls.value,2);assert.equal(new Set(calls.batches).size,2)
    assert.equal(final.run.items[0]!.steps.find(s=>s.nodeId==='g3')!.error?.code,'CREDIT_EXHAUSTED')
    const balance=await createAccountBilling(f.db).balanceFor(f.a);assert.equal(balance.actualBalanceUsd,'-0.100000000000');assert.equal(balance.confirmedSpendUsd,'0.500000000000')
    assert.equal((await repo.listRuns({limit:20,search:''})).runs[0]!.summary.confirmedCostUsd,'0.500000000000')
}))

test('expired paid claims never replay automatically; explicit retries preserve historic rows and require charge confirmation',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),generateNode('g'),createPipelineNode('output','out')],[['input','g'],['g','out']]),[original.url])
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig});await executor.advance(run.id)
    const claim=await repo.claim(run.id);assert.ok(claim)
    const batchId=randomUUID(),database=await useDB(f.db,f.a),settings=createDefaultSettings('google/gemini-3.1-flash-image')
    const pending=await database.createPendingGeneration({prompt:'Keep product',inputImages:[original.url],modelImages:[],requestedModel:'google/gemini-3.1-flash-image',effectiveModel:'google/gemini-3.1-flash-image',batchId,pipelineStepId:claim.step.id,
        generationConfig:{schemaVersion:1,profileVersion:1,requestedModel:'google/gemini-3.1-flash-image',effectiveModel:'google/gemini-3.1-flash-image',settings,storeInputImages:true}})
    await repo.providerStarted(claim.step.id,claim.token,batchId)
    await f.db.update(pipelineRunSteps).set({leaseExpiresAt:sql`CURRENT_TIMESTAMP - INTERVAL '1 second'`}).where(eq(pipelineRunSteps.id,claim.step.id))
    const interrupted=(await executor.advance(run.id)).run;assert.equal(interrupted.items[0]!.steps.find(s=>s.nodeId==='g')!.status,'interrupted')
    await assert.rejects(repo.retry(run.id,{stepIds:[claim.step.id]}),(e:{statusCode:number})=>e.statusCode===409)
    const retried=(await repo.retry(run.id,{stepIds:[claim.step.id],confirmPossibleCharge:true})).run
    assert.notEqual(retried.items[0]!.steps.find(s=>s.nodeId==='g')!.id,claim.step.id)
    assert.equal((await database.getSystemPrompt(pending.id))!.pipelineStepId,claim.step.id)
    const old=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.id,claim.step.id));assert.equal(old[0]!.active,false)
}))

test('default text utility settings persist the actual model, confirm its charge, and keep text calls out of image history',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');if(text.type==='static-text')text.config.text='A red handbag'
    const {run}=await saveStart(repo,graph([text,createPipelineNode('prompt-enhancer','enhance'),createPipelineNode('output','out')],[['text','enhance','text'],['enhance','out']]))
    let starts=0
    const gateway={async getGenerationBilling(){return undefined},async generatePipelineText(request:{model:string;system?:string},_signal:AbortSignal,start:()=>Promise<void>){
        assert.equal(request.model,'google/gemini-2.5-flash');assert.equal(request.system,undefined);await start();starts++
        return {text:'A studio photograph of a red handbag',warnings:[],billing:{model:request.model,priceSource:'gateway',priceUsd:'0.012',gatewayGenerationId:'gen_text_local',usageJson:{gatewayBilling:{isByok:false}}}}
    }} as unknown as Awaited<ReturnType<typeof useGateway>>
    const done=await drain(createPipelineExecutor(f.a,repo,{gateway,runtimeConfig,coordinationPool:f.pool}),run.id)
    assert.equal(starts,1);assert.equal(done.status,'succeeded');assert.equal(done.items[0]!.steps.at(-1)!.value!.text,'A studio photograph of a red handbag')
    const rows=await f.db.select().from(systemPrompt);assert.equal(rows[0]!.generationConfig,null);assert.equal(rows[0]!.pipelineTextConfig!.model,'google/gemini-2.5-flash')
    assert.equal(await (await useDB(f.db,f.a)).countSystemPrompts(),0);assert.equal(done.summary.confirmedCostUsd,'0.012000000000')
}))

for (const model of ['zai/glm-5.3-flash', 'openai/gpt-6-luna'] as const)
test(`the ${model} enhancer preserves immutable model, effort and actual billing when the saved graph changes`, integration, async () => fixture(async f => {
    const fs = await useUserFS(f.a, f.raw, f.db), repo = createPipelineRepository(f.a, f.db, {storage: fs})
    const source = await fs.saveUpload('/', upload(f.bytes))
    const text = createPipelineNode('static-text', 'text'); text.config.text = 'A red bag with a green label'
    const image = createPipelineNode('static-image', 'image'); image.config.images = [source.url]
    const enhancer = createPipelineNode('prompt-enhancer', 'enhance')
    enhancer.config = PromptEnhancerConfigSchema.parse({model, reasoningEffort: 'max', systemPrompt: 'Return only the improved prompt.',
        prompt: 'Preserve the label text.', maxOutputTokens: 8192, ...(model === 'zai/glm-5.3-flash' ? {temperature: 0.3} : {})})
    const definition = graph([text, image, enhancer, createPipelineNode('output', 'out')],
        [['text', 'enhance', 'text'], ['image', 'enhance', 'image'], ['enhance', 'out']])
    const {pipeline, run} = await saveStart(repo, definition)
    const updated = structuredClone(definition), replacement = updated.nodes.find(value => value.id === 'enhance')!
    if (replacement.type === 'prompt-enhancer') replacement.config = PromptEnhancerConfigSchema.parse({model: 'google/gemini-2.5-flash'})
    await repo.update(pipeline.id, {revision: pipeline.revision, name: pipeline.name, description: '', definition: updated})
    let captured: PipelineTextRequest | undefined, starts = 0
    const gateway = {async getGenerationBilling() {return undefined},
        async generatePipelineText(request: PipelineTextRequest, _signal: AbortSignal, start: () => Promise<void>) {
            captured = request; await start(); starts++
            return {text: 'A studio photograph of the red bag with a crisp green label.', warnings: [], billing: {
                model, priceSource: 'gateway', priceUsd: '0.034567890123', gatewayGenerationId: 'gen_enhancer_snapshot',
                reasoningTokens: 6, usageJson: {gatewayBilling: {isByok: false}},
            }}
        }} as unknown as Awaited<ReturnType<typeof useGateway>>
    const done = await drain(createPipelineExecutor(f.a, repo, {gateway, runtimeConfig, coordinationPool: f.pool}), run.id)
    assert.equal(starts, 1); assert.equal(done.status, 'succeeded')
    assert.equal(captured!.model, model); assert.equal(captured!.reasoningEffort, 'max')
    assert.equal(captured!.maxOutputTokens, 8192); assert.equal(captured!.system, 'Return only the improved prompt.')
    assert.deepEqual(captured!.imageUrls, [source.url])
    assert.equal(captured!.temperature, model === 'zai/glm-5.3-flash' ? 0.3 : undefined)
    assert.equal(done.definition.nodes.find(value => value.id === 'enhance')!.config.model, model)
    const rows = await f.db.select().from(systemPrompt), stored = rows[0]!.pipelineTextConfig!
    assert.equal(stored.model, model); assert.equal('reasoningEffort' in stored && stored.reasoningEffort, 'max')
    assert.equal(stored.maxOutputTokens, 8192); assert.deepEqual(stored.imageUrls, [source.url])
    assert.equal(stored.temperature, model === 'zai/glm-5.3-flash' ? 0.3 : undefined)
    assert.equal(rows[0]!.generationModel, model); assert.equal(rows[0]!.reasoningTokens, 6)
    assert.equal(rows[0]!.generationConfig, null)
    assert.equal(done.summary.confirmedCostUsd, '0.034567890123')
    assert.equal(await (await useDB(f.db, f.a)).countSystemPrompts(), 0)
}))

test('cancellation during local work prevents publication and deletes only the staged object',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('crop','crop'),createPipelineNode('output','out')],[['input','crop'],['crop','out']]),[original.url])
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,processImage:async(...args)=>{const result=await processLocalPipelineImage(...args);await repo.cancel(run.id);return result}})
    await executor.advance(run.id);const before=[...f.objects.keys()];const cancelled=(await executor.advance(run.id)).run
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.items[0]!.steps.find(s=>s.nodeId==='crop')!.status,'cancelled')
    assert.deepEqual([...f.objects.keys()].filter(key=>!key.endsWith('/')),before.filter(key=>!key.endsWith('/')));assert.equal((await f.db.select().from(pipelineStepOutputs)).length,0)
    assert.deepEqual((await fs.getImageFile(original.url)).buffer,f.bytes)
}))

test('account changes fence provider work even when a step was claimed with an earlier auth version',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');if(text.type==='static-text')text.config.text='Hello'
    const {run}=await saveStart(repo,graph([text,createPipelineNode('output','out')],[['text','out']]))
    const claim=await repo.claim(run.id);assert.ok(claim)
    await f.db.update(users).set({authVersion:2}).where(eq(users.id,f.a.userId))
    await assert.rejects(repo.providerStarted(claim.step.id,claim.token,randomUUID()),(e:{statusCode:number})=>e.statusCode===401)
    await assert.rejects(repo.claim(run.id),(e:{statusCode:number})=>e.statusCode===401)
}))

test('background removal maps multiple pictures through durable jobs one at a time without re-enqueueing completed sources',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const images=await Promise.all([fs.saveUpload('/',upload(f.bytes)),fs.saveUpload('/',upload(f.bytes))])
    const source=createPipelineNode('static-image','images');if(source.type==='static-image')source.config.images=images.map(i=>i.url)
    const {run}=await saveStart(repo,graph([source,createPipelineNode('remove-background','cutout'),createPipelineNode('output','out')],[['images','cutout'],['cutout','out']]))
    const background=createBackgroundRemovalRepository(f.db);let inference=0
    const worker=createBackgroundRemovalRunner({repository:background,actor:async()=>f.a,storage:async()=>fs,infer:async input=>{inference++;return{buffer:input.buffer,mimeType:'image/png',width:24,height:16,byteSize:input.buffer.length,modelVersion:getBackgroundRemovalModel(input.model).version}}})
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,background,kickBackground:()=>worker.kick(),backgroundWaitMs:5000})
    const done=await drain(executor,run.id);await worker.close()
    assert.equal(inference,2);assert.equal(done.status,'succeeded');assert.equal(done.items[0]!.steps.at(-1)!.value!.images.length,2)
    for(const image of done.items[0]!.steps.at(-1)!.value!.images)assert.equal(image.priceSource,'local-processing')
}))


test('known-zero local pipelines remain usable at exhausted finite credit',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    await f.db.update(users).set({creditBalanceUnits:'0'}).where(eq(users.id,f.a.userId))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('resize','resize'),createPipelineNode('output','out')],[['input','resize'],['resize','out']]),[original.url])
    const done=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}),run.id)
    assert.equal(done.status,'succeeded');assert.equal((await createAccountBilling(f.db).balanceFor(f.a)).actualBalanceUsd,'0.000000000000')
}))

test('zero-credit retry refuses paid descendants atomically while a local execution slice can retry',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const definition=graph([createPipelineNode('image-input','input'),generateNode('paid'),createPipelineNode('output','out')],[['input','paid'],['paid','out']])
    const {pipeline,run}=await saveStart(repo,definition,[original.url])
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig})
    const claim=await repo.claim(run.id);assert.ok(claim);assert.equal(claim.node.type,'image-input')
    await repo.finish(claim.step.id,claim.token,'failed',null,{code:'LOCAL_TEST_FAILURE',message:'Fixture local input failed',retryable:true})
    const failed=await drain(executor,run.id);assert.equal(failed.status,'failed')
    await f.db.update(users).set({creditBalanceUnits:'0'}).where(eq(users.id,f.a.userId))
    const before=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id))
    await assert.rejects(repo.retry(run.id,{stepIds:[claim.step.id]}),(error:any)=>{
        assert.equal(error.statusCode,402);assert.deepEqual(error.data,{code:CREDIT_EXHAUSTED_CODE});return true
    })
    assert.deepEqual(await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id)),before,'refusal must not replace steps or change attempt history')
    assert.equal((await repo.detail(run.id)).status,'failed')
    // Running only the input excludes the paid descendant. The same exhausted
    // account may retry this local execution slice without a provider charge.
    const local=(await repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{},inputImages:[original.url],batchInputNodeId:'input',targetNodeId:'input'})).run
    const localClaim=await repo.claim(local.id);assert.ok(localClaim)
    await repo.finish(localClaim.step.id,localClaim.token,'failed',null,{code:'LOCAL_TEST_FAILURE',message:'Fixture local input failed',retryable:true})
    const localDone=await drain(executor,local.id);assert.equal(localDone.status,'failed')
    const retried=(await repo.retry(local.id,{stepIds:[localClaim.step.id]})).run
    assert.equal(retried.status,'queued');assert.equal(retried.items[0]!.steps.length,1)
    const retryRows=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,local.id))
    assert.equal(retryRows.find(step=>step.active)!.attempt,2)
    assert.equal((await drain(executor,local.id)).status,'succeeded')
    assert.equal((await createAccountBilling(f.db).balanceFor(f.a)).actualBalanceUsd,'0.000000000000')
    assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}

test('forced overlap of local publication and cancellation completes without inverted account/run locks',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('crop','crop'),createPipelineNode('output','out')],[['input','crop'],['crop','out']]),[original.url])
    await createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}).advance(run.id)
    const claim=await repo.claim(run.id);assert.ok(claim)
    const staged=await fs.prepareProcessedImage(f.bytes,{purpose:'pipeline'}),entered=gate(),release=gate(),value={images:[],text:null} as import('../schemas/pipelines.ts').PipelineValue
    const publishing=repo.finish(claim.step.id,claim.token,'succeeded',value,null,async tx=>{
        entered.resolve();await release.promise
        const output=await staged.register(tx,{id:original.id!,url:original.url});await repo.registerProcessed(tx,claim.step.id,output)
        value.images.push({id:output.outputAssetId,url:output.outputUrl,name:'Fixture',priceUsd:'0',priceSource:'local-processing'})
    },[original.url])
    await entered.promise
    let cancelled=false;const cancelling=repo.cancel(run.id).then(result=>{cancelled=true;return result})
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(cancelled,false)
    release.resolve();const [published,result]=await Promise.all([publishing,cancelling])
    assert.equal(published,true);assert.equal(result.run.status,'cancelled');assert.equal(result.run.items[0]!.steps.find(s=>s.nodeId==='crop')!.status,'succeeded')
    assert.deepEqual((await fs.getImageFile(staged.url)).buffer,f.bytes)
}))

test('reciprocal shared-source local publications hold compatible sorted account locks',integration,async()=>fixture(async f=>{
    const aFS=await useUserFS(f.a,f.raw,f.db),bFS=await useUserFS(f.b,f.raw,f.db)
    const aImage=await aFS.saveUpload('/',upload(f.bytes)),bImage=await bFS.saveUpload('/',upload(f.bytes))
    await aFS.share(aImage.id!,f.b.userId,'view');await bFS.share(bImage.id!,f.a.userId,'view')
    const repos=[createPipelineRepository(f.a,f.db,{storage:aFS}),createPipelineRepository(f.b,f.db,{storage:bFS})]
    const sources=[bImage,aImage],stores=[aFS,bFS],actors=[f.a,f.b]
    const runs=await Promise.all(repos.map((repo,i)=>saveStart(repo,graph([createPipelineNode('image-input','input'),createPipelineNode('crop','crop'),createPipelineNode('output','out')],[['input','crop'],['crop','out']]),[sources[i]!.url])))
    await Promise.all(repos.map((repo,i)=>createPipelineExecutor(actors[i]!,repo,{gateway:noGateway,runtimeConfig}).advance(runs[i]!.run.id)))
    const claims=await Promise.all(repos.map((repo,i)=>repo.claim(runs[i]!.run.id)));assert.ok(claims.every(Boolean))
    const stages=await Promise.all(stores.map(fs=>fs.prepareProcessedImage(f.bytes,{purpose:'pipeline'}))),entered=[gate(),gate()],release=gate()
    const work=repos.map((repo,i)=>repo.finish(claims[i]!.step.id,claims[i]!.token,'succeeded',{images:[],text:null},null,async tx=>{
        entered[i]!.resolve();await release.promise;const output=await stages[i]!.register(tx,{id:sources[i]!.id!,url:sources[i]!.url});await repo.registerProcessed(tx,claims[i]!.step.id,output)
    },[sources[i]!.url]))
    await Promise.all(entered.map(value=>value.promise));release.resolve();assert.deepEqual(await Promise.all(work),[true,true])
}))


test('pipeline and run keyset cursors preserve PostgreSQL microseconds within one millisecond',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');if(text.type==='static-text')text.config.text='Fixture'
    const definition=graph([text,createPipelineNode('output','out')],[['text','out']]),expectedPipelines:string[]=[],expectedRuns:string[]=[]
    for(const fraction of ['000111','000222','000333']){
        const {pipeline,run}=await saveStart(repo,definition)
        await f.db.update(pipelines).set({createdAt:`2026-01-01 00:00:00.${fraction}+00`}).where(eq(pipelines.id,pipeline.id))
        await f.db.update(pipelineRuns).set({createdAt:`2026-01-01 00:00:00.${fraction}+00`}).where(eq(pipelineRuns.id,run.id))
        expectedPipelines.unshift(pipeline.id);expectedRuns.unshift(run.id)
    }
    const foundPipelines:string[]=[],foundRuns:string[]=[];let cursor:string|undefined
    do{const page=await repo.list({limit:1,search:'',cursor});foundPipelines.push(...page.pipelines.map(p=>p.id));cursor=page.nextCursor??undefined}while(cursor)
    cursor=undefined
    do{const page=await repo.listRuns({limit:1,search:'',cursor});foundRuns.push(...page.runs.map(r=>r.id));cursor=page.nextCursor??undefined}while(cursor)
    assert.deepEqual(foundPipelines,expectedPipelines);assert.deepEqual(foundRuns,expectedRuns)
}))


test('Expand maps multiple connected images through immutable canvases and separate priced provider waves',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const originals=await Promise.all([fs.saveUpload('/',upload(f.bytes)),fs.saveUpload('/',upload(f.bytes))])
    const images=createPipelineNode('static-image','images');if(images.type==='static-image')images.config.images=originals.map(image=>image.url)
    const expand=createPipelineNode('expand','expand');if(expand.type==='expand'){expand.config.top=2;expand.config.bottom=2;expand.config.left=3;expand.config.right=3;expand.config.model='openai/gpt-image-2';expand.config.settings=createDefaultSettings('openai/gpt-image-2')}
    const {run}=await saveStart(repo,graph([images,expand,createPipelineNode('output','out')],[['images','expand'],['expand','out']]))
    const calls={value:0,batches:[] as string[]},generate=fakeGeneration(f,fs,'gateway',calls)
    const actualRequests:import('../schemas/image-generation.ts').ImageGenerationRequest[]=[]
    const executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate:async(...args)=>{
        actualRequests.push(args[1]);assert.equal(args[1].inputImages.length,1);assert.ok(args[1].maskImage)
        const canvas=await fs.getImageFile(args[1].inputImages[0]!),mask=await fs.getImageFile(args[1].maskImage!)
        assert.equal(canvas.width,30);assert.equal(canvas.height,20);assert.equal(mask.width,30);assert.equal(mask.height,20)
        return generate(...args)
    }})
    const done=await drain(executor,run.id)
    assert.equal(done.status,'succeeded');assert.equal(calls.value,2);assert.equal(new Set(calls.batches).size,2)
    assert.equal(done.items[0]!.steps.at(-1)!.value!.images.length,2)
    assert.equal((await f.db.select().from(pipelineStepOutputs)).length,4)
    assert.ok(actualRequests.every(request=>request.model==='openai/gpt-image-2'))
    for(const image of originals)assert.deepEqual((await fs.getImageFile(image.url)).buffer,f.bytes)
}))

 test('Translate and generative Upscale replay selected image profiles and preserve actual returned metadata',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),original=await fs.saveUpload('/',upload(f.bytes))
    const translate=createPipelineNode('translate','translate');if(translate.type==='translate')translate.config.language='Hungarian'
    const upscale=createPipelineNode('upscale','upscale');if(upscale.type==='upscale')upscale.config.mode='ai'
    const {run}=await saveStart(repo,graph([createPipelineNode('image-input','input'),translate,upscale,createPipelineNode('output','out')],[['input','translate'],['translate','upscale'],['upscale','out']]),[original.url])
    const calls={value:0,batches:[] as string[]},generate=fakeGeneration(f,fs,'gateway',calls),prompts:string[]=[]
    const done=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate:async(...args)=>{prompts.push(args[1].prompt);return generate(...args)}}),run.id)
    assert.equal(done.status,'succeeded');assert.equal(calls.value,2);assert.match(prompts[0]!,/Hungarian/);assert.match(prompts[1]!,/2 times/)
    const result=done.items[0]!.steps.at(-1)!.value!.images[0]!;assert.equal(result.width,24);assert.equal(result.height,16);assert.equal(result.mimeType,'image/png');assert.equal(result.bytes,f.bytes.length)
}))


test('charged text persistence failure retains authoritative billing and reconciles its finite-credit charge once',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');if(text.type==='static-text')text.config.text='A handbag'
    const {run}=await saveStart(repo,graph([text,createPipelineNode('llm','llm'),createPipelineNode('output','out')],[['text','llm','text'],['llm','out']]))
    await f.db.update(users).set({creditBalanceUnits:'1000000000000'}).where(eq(users.id,f.a.userId))
    const actual=await useDB(f.db,f.a),database={...actual,completeGeneration:async()=>{throw new Error('private persistence diagnostic')}}
    let calls=0
    const gateway={async getGenerationBilling(){return undefined},async generatePipelineText(_request:unknown,_signal:AbortSignal,start:()=>Promise<void>){await start();calls++;return{text:'A description',warnings:[],billing:{priceSource:'gateway',priceUsd:'0.012',gatewayGenerationId:'gen_text_failure',usageJson:{gatewayBilling:{isByok:false}}}}}} as unknown as Awaited<ReturnType<typeof useGateway>>
    const executor=createPipelineExecutor(f.a,repo,{gateway,runtimeConfig,coordinationPool:f.pool,generationDatabase:database})
    const done=await drain(executor,run.id);assert.equal(calls,1);assert.equal(done.status,'partial')
    const rows=await f.db.select().from(systemPrompt);assert.equal(rows[0]!.status,'failed');assert.equal(rows[0]!.priceUsd,'0.012');assert.equal(rows[0]!.gatewayGenerationId,'gen_text_failure');assert.equal(rows[0]!.billingState,'confirmed')
    assert.ok(!JSON.stringify(done).includes('private persistence diagnostic'))
    const balance=await createAccountBilling(f.db).balanceFor(f.a);assert.equal(balance.actualBalanceUsd,'0.988000000000');assert.equal(balance.outstandingCount,0)
    await executor.get(run.id);assert.equal((await createAccountBilling(f.db).balanceFor(f.a)).actualBalanceUsd,'0.988000000000')
}))


test('bulk owned-image metadata applies fresh ancestry, exact-price, expiry, BYOK and tenant checks in one query',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),bFS=await useUserFS(f.b,f.raw,f.db)
    const folder=await fs.createFolder('/','Private parent'),child=await fs.saveUpload('/Private parent',upload(f.bytes)),ordinary=await fs.saveUpload('/',upload(f.bytes))
    const shared=await bFS.saveUpload('/',upload(f.bytes));await bFS.share(shared.id!,f.a.userId,'view')
    const database=await useDB(f.db,f.a),settings=createDefaultSettings('google/gemini-3.1-flash-image'),pending=await database.createPendingGeneration({prompt:'Fixture',inputImages:[],modelImages:[],requestedModel:'google/gemini-3.1-flash-image',effectiveModel:'google/gemini-3.1-flash-image',batchId:randomUUID(),
        generationConfig:{schemaVersion:1,profileVersion:1,requestedModel:'google/gemini-3.1-flash-image',effectiveModel:'google/gemini-3.1-flash-image',settings,storeInputImages:true}})
    const generated=await fs.saveGeneratedImage(f.bytes,'image/png');await database.completeGeneration(pending.id,{outputImage:generated.url,outputMetadata:{mimeType:'image/png',bytes:f.bytes.length,width:24,height:16,warnings:[]},billing:{priceSource:'estimate',priceUsd:'0.1',gatewayGenerationId:'gen_bulk'},log:{status:'success',model:'google/gemini-3.1-flash-image',prompt:'Fixture'}})
    const paths=[ordinary.url,child.url,generated.url,shared.url],originalExecute=f.db.execute.bind(f.db);let queries=0
    f.db.execute=((...args:Parameters<typeof f.db.execute>)=>{queries++;return originalExecute(...args)}) as typeof f.db.execute
    const held=await fs.ownedImageMetadata(paths);assert.equal(queries,1);assert.deepEqual(new Set(held.images.map(i=>i.url)),new Set([ordinary.url,child.url]));assert.ok(held.ownedUrls.includes(generated.url));assert.ok(!held.ownedUrls.includes(shared.url))
    assert.equal((await fs.assetByUrl(shared.url)).id,shared.id,'shared fallback still uses its live grant')
    await database.updateSystemPromptBilling(pending.id,{priceSource:'gateway',priceUsd:'0',gatewayGenerationId:'gen_bulk',usageJson:{gatewayBilling:{isByok:false}}})
    assert.equal((await fs.ownedImageMetadata(paths)).images.find(image=>image.url===generated.url)!.priceUsd,'0')
    await f.db.update(systemPrompt).set({usageJson:{gatewayBilling:{isByok:true}}}).where(eq(systemPrompt.id,pending.id));assert.ok(!(await fs.ownedImageMetadata(paths)).images.some(image=>image.url===generated.url))
    await f.db.update(systemPrompt).set({usageJson:{gatewayBilling:{isByok:false}},outputImageDeletedAt:sql`CURRENT_TIMESTAMP`}).where(eq(systemPrompt.id,pending.id));assert.ok(!(await fs.ownedImageMetadata(paths)).images.some(image=>image.url===generated.url))
    await f.db.update(assets).set({deletedAt:sql`CURRENT_TIMESTAMP`}).where(eq(assets.id,folder.id!));assert.ok(!(await fs.ownedImageMetadata(paths)).images.some(image=>image.url===child.url))
    const strangerFS=await useUserFS(f.stranger,f.raw,f.db);assert.deepEqual(await strangerFS.ownedImageMetadata(paths),{images:[],ownedUrls:[]})
    await f.db.update(users).set({disabledAt:sql`CURRENT_TIMESTAMP`}).where(eq(users.id,f.a.userId));assert.equal((await fs.ownedImageMetadata(paths)).images.length,0)
}))

test('worker shutdown during claim cleans its owned step claim before any paid call starts',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const text=createPipelineNode('static-text','text');if(text.type==='static-text')text.config.text='Fixture'
    const {run}=await saveStart(repo,graph([text,createPipelineNode('output','out')],[['text','out']])),controller=new AbortController()
    const wrapped={...repo,claim:async(id:string)=>{const result=await repo.claim(id);controller.abort(new Error('Worker shutdown'));return result}}
    const result=await createPipelineExecutor(f.a,wrapped,{gateway:noGateway,runtimeConfig,signal:controller.signal}).advance(run.id)
    assert.ok(result.run.items[0]!.steps.every(step=>step.status!=='running'))
    const records=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id));assert.ok(records.every(step=>step.claimToken===null&&step.leaseExpiresAt===null))
    assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

test('People Input freezes chosen own/shared photos across independent batch items, branches and later profile edits',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),otherFS=await useUserFS(f.b,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const owned=createPeopleRepository(f.a,f.db),shared=createPeopleRepository(f.b,f.db)
    const ownPerson=(await owned.create({name:'Own person'})).person,sharedPerson=(await shared.create({name:'Shared person'})).person
    const ownPhoto=await fs.saveUpload('/',upload(f.bytes)),sharedPhoto=await otherFS.saveUpload('/',upload(f.bytes))
    await owned.addPhotos(ownPerson.id,{urls:[ownPhoto.url]});await shared.addPhotos(sharedPerson.id,{urls:[sharedPhoto.url]});await shared.share(sharedPerson.id,{recipientUserId:f.a.userId})
    const people=createPipelineNode('people-input','people');people.config.images=[ownPhoto.url,sharedPhoto.url]
    const products=await Promise.all([fs.saveUpload('/',upload(f.bytes)),fs.saveUpload('/',upload(f.bytes))])
    const definition=graph([createPipelineNode('image-input','input'),people,generateNode('generate'),createPipelineNode('output','result'),createPipelineNode('output','photos')],
        [['input','generate'],['people','generate','references'],['generate','result'],['people','photos']])
    const {pipeline,run}=await saveStart(repo,definition,products.map(image=>image.url))
    const newer=await fs.saveUpload('/',upload(f.bytes));await owned.addPhotos(ownPerson.id,{urls:[newer.url]})
    await repo.update(pipeline.id,{revision:1,name:'Changed selection',definition:{...definition,nodes:definition.nodes.map(node=>node.type==='people-input'?{...node,config:{images:[newer.url]}}:node)}})
    const calls={value:0,batches:[] as string[]},generate=fakeGeneration(f,fs,'gateway',calls),references:string[][]=[]
    const done=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate:async(...args)=>{references.push(args[1].modelImages);return generate(...args)}}),run.id)
    assert.equal(done.status,'succeeded');assert.equal(done.summary.succeeded,2);assert.equal(calls.value,2)
    assert.deepEqual(references,[[ownPhoto.url,sharedPhoto.url],[ownPhoto.url,sharedPhoto.url]])
    for(const item of done.items){
        assert.deepEqual(item.steps.find(step=>step.nodeId==='people')!.value!.images.map(image=>image.url),[ownPhoto.url,sharedPhoto.url])
        assert.equal(item.steps.find(step=>step.nodeId==='result')!.value!.images.length,1)
        assert.deepEqual(item.steps.find(step=>step.nodeId==='photos')!.value!.images.map(image=>image.url),[ownPhoto.url,sharedPhoto.url])
    }
    assert.deepEqual(done.definition.nodes.find(node=>node.type==='people-input')!.config.images,[ownPhoto.url,sharedPhoto.url])
    assert.deepEqual((await repo.get(pipeline.id)).pipeline.definition.nodes.find(node=>node.type==='people-input')!.config.images,[newer.url])
    assert.deepEqual((await fs.getImageFile(ownPhoto.url)).buffer,f.bytes);assert.deepEqual((await otherFS.getImageFile(sharedPhoto.url)).buffer,f.bytes)
}))

test('People Input rejects Library forgery, private/cross-organization photos, empty runs and batch overrides',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs})
    const library=await fs.saveUpload('/',upload(f.bytes)),photos:string[]=[library.url]
    for(const actor of [f.b,f.stranger]){
        const otherFS=await useUserFS(actor,f.raw,f.db),people=createPeopleRepository(actor,f.db),person=(await people.create({name:'Private person'})).person,image=await otherFS.saveUpload('/',upload(f.bytes))
        await people.addPhotos(person.id,{urls:[image.url]});photos.push(image.url)
    }
    for(const url of photos){
        const people=createPipelineNode('people-input','people');people.config.images=[url]
        await assert.rejects(repo.create({name:'Forged People',definition:graph([people,createPipelineNode('output','out')],[['people','out']])}),(e:{statusCode:number})=>e.statusCode===404)
    }
    const empty=createPipelineNode('people-input','people'),draft=(await repo.create({name:'Incomplete',definition:graph([empty,createPipelineNode('output','out')],[['people','out']])})).pipeline
    await assert.rejects(repo.start(draft.id,{revision:1,idempotencyKey:randomUUID(),inputs:{}}),(e:{statusCode:number})=>e.statusCode===400)
    const owned=createPeopleRepository(f.a,f.db),person=(await owned.create({name:'Valid'})).person;await owned.addPhotos(person.id,{urls:[library.url]})
    empty.config.images=[library.url];const {pipeline}=await repo.create({name:'Fixed People',definition:graph([empty,createPipelineNode('output','out')],[['people','out']])})
    await assert.rejects(repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),batchInputNodeId:'people',inputImages:[library.url],inputs:{}}),(e:{statusCode:number})=>e.statusCode===400)
    await assert.rejects(repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{people:library.url}}),(e:{statusCode:number})=>e.statusCode===400)
    assert.equal((await f.db.select().from(pipelineRuns)).length,0)
}))

test('People provenance keeps exact-price gating including zero charges, deleted outputs and unlinked photos',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),people=createPeopleRepository(f.a,f.db)
    const person=(await people.create({name:'Generated person'})).person,database=await useDB(f.db,f.a),profile=getImageModelProfile('google/gemini-3.1-flash-image')!
    const row=await database.createPendingGeneration({prompt:'Fixture portrait',personId:person.id,inputImages:[],modelImages:[],requestedModel:profile.id,effectiveModel:profile.id,batchId:randomUUID(),
        generationConfig:{schemaVersion:1,profileVersion:profile.profileVersion,requestedModel:profile.id,effectiveModel:profile.id,settings:createDefaultSettings(profile.id),storeInputImages:true}})
    const output=await fs.saveGeneratedImage(f.bytes,'image/png');await database.completeGeneration(row.id,{outputImage:output.url,outputMetadata:{mimeType:'image/png',width:24,height:16,bytes:f.bytes.length,warnings:[]},
        billing:{priceSource:'estimate',priceUsd:'0.01',gatewayGenerationId:'gen_people_input',usageJson:{gatewayBilling:{isByok:false}}},log:{status:'success',model:profile.id,prompt:'Fixture'}})
    const input=createPipelineNode('people-input','people');input.config.images=[output.url];const definition=graph([input,createPipelineNode('output','out')],[['people','out']])
    await assert.rejects(repo.create({name:'Unpriced',definition}),(e:{statusCode:number})=>e.statusCode===404)
    await database.updateSystemPromptBilling(row.id,{priceSource:'gateway',priceUsd:'0',gatewayGenerationId:'gen_people_input',usageJson:{gatewayBilling:{isByok:false}}})
    const {pipeline,run}=await saveStart(repo,definition),done=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig}),run.id)
    assert.equal(done.status,'succeeded');assert.equal(done.items[0]!.steps.at(-1)!.value!.images[0]!.priceUsd,'0')
    const outputAsset=await fs.assetByUrl(output.url)
    await people.removePhoto(person.id,outputAsset.id!)
    assert.equal((await fs.assetByUrl(output.url)).id,outputAsset.id,'owned Library access survives unlinking')
    assert.ok(!JSON.stringify((await repo.get(pipeline.id)).pipeline).includes(output.url))
    assert.ok(!JSON.stringify(await repo.detail(run.id)).includes(output.url),'People and pass-through output values also redact withdrawn photo paths')
    await assert.rejects(repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{}}),(e:{statusCode:number})=>e.statusCode===404)
    await people.addPhotos(person.id,{urls:[output.url]});await f.db.update(systemPrompt).set({outputImageDeletedAt:sql`CURRENT_TIMESTAMP`}).where(eq(systemPrompt.id,row.id))
    assert.ok(!JSON.stringify((await repo.get(pipeline.id)).pipeline).includes(output.url))
    assert.equal((await f.db.select().from(systemPrompt)).length,1,'source withdrawal preserves charge and generation history')
}))

test('revoked People grants stop descendant paid work after an owned local intermediate while independent file grants survive',integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs})
    const person=(await people.create({name:'Shared portrait'})).person,photo=await sourceFS.saveUpload('/',upload(f.bytes));await people.addPhotos(person.id,{urls:[photo.url]});await people.share(person.id,{recipientUserId:f.b.userId});await sourceFS.share(photo.id!,f.b.userId,'view')
    const input=createPipelineNode('people-input','people');input.config.images=[photo.url];const resize=createPipelineNode('resize','resize');resize.config={width:24,height:16,fit:'contain',background:'transparent'}
    const {pipeline,run}=await saveStart(repo,graph([input,resize,generateNode('generate'),createPipelineNode('output','out')],[['people','resize'],['resize','generate'],['generate','out']]))
    const calls={value:0,batches:[] as string[]},executor=createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig,generate:fakeGeneration(f,fs,'gateway',calls)})
    await executor.advance(run.id);const intermediate=(await executor.advance(run.id)).run.items[0]!.steps.find(step=>step.nodeId==='resize')!.value!.images[0]!
    await people.revoke(person.id,f.b.userId)
    assert.equal((await fs.assetByUrl(photo.url)).id,photo.id);assert.equal((await fs.assetByUrl(intermediate.url)).id,intermediate.id)
    const done=await drain(executor,run.id)
    assert.equal(calls.value,0);assert.equal(done.items[0]!.steps.find(step=>step.nodeId==='generate')!.error?.code,'SOURCE_UNAVAILABLE');assert.equal((await f.db.select().from(systemPrompt)).length,0)
    assert.ok(!JSON.stringify(done).includes(photo.url));assert.ok(!JSON.stringify((await repo.get(pipeline.id)).pipeline).includes(photo.url))
    assert.ok(JSON.stringify(done).includes(intermediate.url),'independently owned completed output remains available')
}))

test('a People share revoked between provider preparation and its committed start fence prevents the paid call',integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs})
    const person=(await people.create({name:'Shared portrait'})).person,photo=await sourceFS.saveUpload('/',upload(f.bytes));await people.addPhotos(person.id,{urls:[photo.url]});await people.share(person.id,{recipientUserId:f.b.userId});await sourceFS.share(photo.id!,f.b.userId,'view')
    const input=createPipelineNode('people-input','people');input.config.images=[photo.url]
    const {run}=await saveStart(repo,graph([input,generateNode('generate'),createPipelineNode('output','out')],[['people','generate','references'],['generate','out']]))
    let calls=0,providerFences=0;const actualFence=repo.providerStarted.bind(repo)
    repo.providerStarted=async(...args)=>{providerFences++;await people.revoke(person.id,f.b.userId);return actualFence(...args)}
    const generate=(async(_actor,_request,options={})=>{await options.beforeProviderCall?.({batchId:randomUUID(),generationIds:[],inputImage:null,signal:new AbortController().signal});calls++;throw new Error('Provider must not run')}) as typeof runAccountImageGeneration
    const done=await drain(createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig,generate}),run.id)
    assert.equal(providerFences,1);assert.equal(calls,0);assert.equal(done.items[0]!.steps.find(step=>step.nodeId==='generate')!.error?.code,'SOURCE_UNAVAILABLE')
    const steps=await f.db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId,run.id));assert.ok(steps.every(step=>step.providerStartedAt===null))
}))

test('People unlink during local processing discards staged bytes instead of publishing a new owned result',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),person=(await people.create({name:'Own portrait'})).person,photo=await fs.saveUpload('/',upload(f.bytes))
    await people.addPhotos(person.id,{urls:[photo.url]});const input=createPipelineNode('people-input','people');input.config.images=[photo.url]
    const {run}=await saveStart(repo,graph([input,createPipelineNode('resize','resize'),createPipelineNode('output','out')],[['people','resize'],['resize','out']]))
    const imageKeys=()=>new Set([...f.objects.keys()].filter(key=>!key.endsWith('/')))
    const initialKeys=imageKeys(),executor=createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,processImage:async(...args)=>{const result=await processLocalPipelineImage(...args);await people.removePhoto(person.id,photo.id!);return result}})
    const done=await drain(executor,run.id)
    assert.equal(done.items[0]!.steps.find(step=>step.nodeId==='resize')!.error?.code,'SOURCE_UNAVAILABLE');assert.equal((await f.db.select().from(pipelineStepOutputs)).length,0)
    assert.deepEqual(imageKeys(),initialKeys);assert.ok(!JSON.stringify(done).includes(photo.url));assert.deepEqual((await fs.getImageFile(photo.url)).buffer,f.bytes)
}))

test('People source fanout participates in aggregate output limits before a run can be queued',integration,async()=>fixture(async f=>{
    const fs=await useUserFS(f.a,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.a,f.db,{storage:fs}),person=(await people.create({name:'Many pictures'})).person
    const photos=await Promise.all(Array.from({length:16},()=>fs.saveUpload('/',upload(f.bytes))));await people.addPhotos(person.id,{urls:photos.map(photo=>photo.url)})
    const sources=Array.from({length:4},(_,index)=>{const node=createPipelineNode('people-input',`people${index}`);node.config.images=photos.map(photo=>photo.url);return node})
    const {pipeline}=await repo.create({name:'Bounded references',definition:graph([...sources,createPipelineNode('output','out')],sources.map(node=>[node.id,'out']))})
    await assert.rejects(repo.start(pipeline.id,{revision:1,idempotencyKey:randomUUID(),inputs:{}}),(e:{statusCode:number})=>e.statusCode===400)
    assert.equal((await f.db.select().from(pipelineRuns)).length,0);assert.equal((await f.db.select().from(systemPrompt)).length,0)
    const {run}=await saveStart(repo,graph([sources[0]!,generateNode('generate'),createPipelineNode('output','result')],[['people0','generate','references'],['generate','result']]))
    let calls=0
    const generate=(async()=>{calls++;throw new Error('Over-limit references must not reach provider')}) as typeof runAccountImageGeneration
    const done=await drain(createPipelineExecutor(f.a,repo,{gateway:noGateway,runtimeConfig,generate}),run.id)
    assert.equal(calls,0);assert.equal(done.items[0]!.steps.find(step=>step.nodeId==='generate')!.error?.code,'INVALID_STEP_INPUT')
    assert.equal((await f.db.select().from(systemPrompt)).length,0,'exact model reference limits still precede paid admission')
}))

for(const withdrawal of ['revoke','unlink','remove'] as const) test(`People ${withdrawal} during durable cutout inference cannot publish an owned asset through an independent file grant`,integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs})
    const person=(await people.create({name:'Shared portrait'})).person,photo=await sourceFS.saveUpload('/',upload(f.bytes));await people.addPhotos(person.id,{urls:[photo.url]});await people.share(person.id,{recipientUserId:f.b.userId});await sourceFS.share(photo.id!,f.b.userId,'view')
    const input=createPipelineNode('people-input','people');input.config.images=[photo.url]
    const {run}=await saveStart(repo,graph([input,createPipelineNode('remove-background','cutout'),createPipelineNode('output','out')],[['people','cutout'],['cutout','out']]))
    const background=createBackgroundRemovalRepository(f.db),before=new Set(f.objects.keys());let inference=0
    const worker=createBackgroundRemovalRunner({repository:background,actor:async()=>f.b,storage:async()=>fs,infer:async value=>{
        inference++
        if(withdrawal==='revoke')await people.revoke(person.id,f.b.userId)
        else if(withdrawal==='unlink')await people.removePhoto(person.id,photo.id!)
        else await people.remove(person.id)
        return{buffer:value.buffer,mimeType:'image/png',width:24,height:16,byteSize:value.buffer.length,modelVersion:getBackgroundRemovalModel(value.model).version}
    }})
    let done
    try{done=await drain(createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig,background,kickBackground:()=>worker.kick(),backgroundWaitMs:5000}),run.id)}finally{await worker.close()}
    assert.equal(inference,1);assert.equal((await fs.assetByUrl(photo.url)).id,photo.id,'the separate file grant remains usable')
    const jobs=await background.list(f.b);assert.equal(jobs.length,1);assert.equal(jobs[0]!.status,'failed');assert.equal(jobs[0]!.error?.code,'SOURCE_UNAVAILABLE');assert.equal(jobs[0]!.outputUrl,null)
    assert.equal(done.items[0]!.steps.find(step=>step.nodeId==='cutout')!.error?.code,'SOURCE_UNAVAILABLE')
    assert.equal((await f.db.select().from(assets).where(eq(assets.category,'processed'))).length,0)
    assert.deepEqual(new Set(f.objects.keys()),before);assert.ok(!JSON.stringify(done).includes(photo.url));assert.equal((await f.db.select().from(systemPrompt)).length,0)
}))

test('durable People cutouts are atomically linked before queue consumption and recheck provenance before reading bytes',integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs})
    const person=(await people.create({name:'Shared portrait'})).person,photo=await sourceFS.saveUpload('/',upload(f.bytes));await people.addPhotos(person.id,{urls:[photo.url]});await people.share(person.id,{recipientUserId:f.b.userId});await sourceFS.share(photo.id!,f.b.userId,'view')
    const input=createPipelineNode('people-input','people');input.config.images=[photo.url]
    const {run}=await saveStart(repo,graph([input,createPipelineNode('remove-background','cutout'),createPipelineNode('output','out')],[['people','cutout'],['cutout','out']]))
    const background=createBackgroundRemovalRepository(f.db),executor=createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig,background,kickBackground:async()=>{},backgroundWaitMs:0})
    await executor.advance(run.id);await executor.advance(run.id)
    const [job]=await background.list(f.b),[step]=await f.db.select().from(pipelineRunSteps).where(and(eq(pipelineRunSteps.runId,run.id),eq(pipelineRunSteps.nodeId,'cutout')))
    assert.ok(job);assert.equal(step!.backgroundRemovalJobId,job.id);assert.equal(step!.status,'queued')
    await people.revoke(person.id,f.b.userId);let inference=0,reads=0
    const counted={...fs,getImageFile:async(...args:Parameters<typeof fs.getImageFile>)=>{reads++;return fs.getImageFile(...args)}}
    const worker=createBackgroundRemovalRunner({repository:background,actor:async()=>f.b,storage:async()=>counted,infer:async()=>{inference++;throw new Error('Withdrawn photo must not reach inference')}})
    await worker.kick();await worker.close()
    assert.equal(inference,0);assert.equal(reads,0);assert.equal((await background.get(f.b,job.id)).error?.code,'SOURCE_UNAVAILABLE')
}))

test('durable People cutout publication rechecks a grant withdrawn after inference and removes only staged bytes',integration,async()=>fixture(async f=>{
    const sourceFS=await useUserFS(f.a,f.raw,f.db),fs=await useUserFS(f.b,f.raw,f.db),people=createPeopleRepository(f.a,f.db),repo=createPipelineRepository(f.b,f.db,{storage:fs})
    const person=(await people.create({name:'Shared portrait'})).person,photo=await sourceFS.saveUpload('/',upload(f.bytes));await people.addPhotos(person.id,{urls:[photo.url]});await people.share(person.id,{recipientUserId:f.b.userId});await sourceFS.share(photo.id!,f.b.userId,'view')
    const input=createPipelineNode('people-input','people');input.config.images=[photo.url]
    const {run}=await saveStart(repo,graph([input,createPipelineNode('remove-background','cutout'),createPipelineNode('output','out')],[['people','cutout'],['cutout','out']]))
    const background=createBackgroundRemovalRepository(f.db),complete=background.complete.bind(background),imageKeys=()=>new Set([...f.objects.keys()].filter(key=>!key.endsWith('/'))),before=imageKeys();let inference=0,publication=0
    background.complete=async(...args)=>{publication++;await people.revoke(person.id,f.b.userId);return complete(...args)}
    const worker=createBackgroundRemovalRunner({repository:background,actor:async()=>f.b,storage:async()=>fs,infer:async value=>{inference++;return{buffer:value.buffer,mimeType:'image/png',width:24,height:16,byteSize:value.buffer.length,modelVersion:getBackgroundRemovalModel(value.model).version}}})
    try{await drain(createPipelineExecutor(f.b,repo,{gateway:noGateway,runtimeConfig,background,kickBackground:()=>worker.kick(),backgroundWaitMs:5000}),run.id)}finally{await worker.close()}
    const [job]=await background.list(f.b);assert.equal(inference,1);assert.equal(publication,1);assert.equal(job!.status,'failed');assert.equal(job!.outputUrl,null);assert.equal(job!.error?.code,'SOURCE_UNAVAILABLE')
    assert.deepEqual(imageKeys(),before);assert.equal((await f.db.select().from(assets).where(eq(assets.category,'processed'))).length,0)
}))
