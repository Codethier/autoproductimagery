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
import {organizations, users, assets, pipelines, pipelineRuns, pipelineRunSteps, pipelineStepOutputs, systemPrompt} from '../server/db/schema.ts'
import {createS3ImageStorage, type ImageStorageCommand} from '../server/utils/useFS.ts'
import {useUserFS} from '../server/utils/useUserFS.ts'
import {createPipelineRepository} from '../server/utils/pipelineRepository.ts'
import {createPipelineExecutor} from '../server/utils/pipelineRunner.ts'
import {useDB} from '../server/utils/useDB.ts'
import {createAccountBilling} from '../server/utils/accountBilling.ts'
import {createBackgroundRemovalRepository} from '../server/utils/backgroundRemovalJobs.ts'
import {createBackgroundRemovalRunner} from '../server/utils/backgroundRemovalRunner.ts'
import {getBackgroundRemovalModel} from '../schemas/background-removal-models.ts'
import {createPipelineNode, type PipelineDefinition, type PipelineNode} from '../schemas/pipelines.ts'
import {getImageModelProfile, createDefaultSettings, generationOutputCount} from '../schemas/image-generation.ts'
import {processLocalPipelineImage} from '../server/utils/pipelineImageProcessing.ts'
import {publicGeneration} from '../server/utils/generationVisibility.ts'
import type {AuthContext} from '../server/utils/accountSession.ts'
import type {useGateway} from '../server/utils/useGateway.ts'
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
async function drain(executor:ReturnType<typeof createPipelineExecutor>, runId:string, limit=40) {
    let value=await executor.get(runId)
    for(let i=0;i<limit&&['queued','running','awaiting-price'].includes(value.run.status);i++)value=await executor.advance(runId)
    return value.run
}

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
