import assert from 'node:assert/strict'
import {IncomingMessage, ServerResponse} from 'node:http'
import {Socket} from 'node:net'
import {registerHooks} from 'node:module'
import test from 'node:test'
import {createError, createEvent, defineEventHandler} from 'h3'
import {createDefaultSettings} from '../schemas/image-generation.ts'
import {parseUsdUnits} from '../schemas/account-billing.ts'

// Exercise the real generation handler, schema parsing, billing allocation,
// error extraction and public projection. Storage/DB/reservation/Gateway are
// test adapters; no image generation or external service is called.
const root = new URL('../', import.meta.url)
const key = '__imageGenerationBillingHandlerTest'
const actor = {organizationId: 'organization-alice', userId: 'alice'}
const dependency = (path: string) => new URL(path, root).href
const mocks = new Map([
  [dependency('server/utils/peopleRepository.ts'), `export const createPeopleRepository = actor => ({requireOwnedPerson: async id => {globalThis.${key}.peopleChecks.push({actor,id}); if(globalThis.${key}.personError)throw globalThis.${key}.personError; return {id};}});`],
  [dependency('server/utils/useDB.ts'), `export const useDB = async (_db, actor) => {globalThis.${key}.dbScopes.push(actor); return globalThis.${key}.database};`],
  [dependency('server/utils/useGateway.ts'), `export const useGateway = async storage => {globalThis.${key}.gatewayInitializations.push(storage); return globalThis.${key}.gateway};`],
  [dependency('server/utils/useUserFS.ts'), `export const useUserFS = async actor => {globalThis.${key}.storageScopes.push(actor); return globalThis.${key}.storage};`],
  [dependency('server/utils/boundedRequestBody.ts'), `export const installBoundedRawBody = async (_event, bytes) => {globalThis.${key}.requestLimit = bytes};`],
  [dependency('server/utils/generationLimiter.ts'), `
    export class GenerationQueueFullError extends Error {}
    export const getGenerationRuntimeSettings = () => ({staleTtlMs: 300000});
    export const getGenerationRequestTimeoutMs = () => 30000;
    export const reserveGenerationBatch = async (...args) => {globalThis.${key}.reservationArguments = args; return globalThis.${key}.reservation};
    export const unresolvedGenerationIndexes = (count, terminal) => Array.from({length: count}, (_, index) => index).filter(index => !terminal.has(index));`],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~~/')) return nextResolve(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url)
    return source ? {format: 'module', shortCircuit: true, source} : nextLoad(url, context)
  },
})
Object.assign(globalThis, {defineEventHandler, createError, useRuntimeConfig: () => ({}), useAuth: async () => actor,
  readBody: async () => (globalThis as any)[key].body})
const handler = (await import('../server/api/image-generate.post.ts')).default

function event() {
  const request = new IncomingMessage(new Socket())
  request.url = '/api/image-generate'; request.method = 'POST'; request.headers = {host: 'localhost', 'content-type': 'application/json'}
  return createEvent(request, new ServerResponse(request))
}
const billed = (source: 'gateway' | 'estimate' | 'unknown' = 'gateway', price = '0.090000000001') => ({model: 'openai/gpt-image-2',
  gatewayGenerationId: 'gen_test_charge', priceUsd: price, priceSource: source, inputTokens: 9, outputTokens: 6, totalTokens: 15,
  usageJson: {gatewayBilling: {id: 'gen_test_charge', isByok: false}}})
const image = (billing = billed()) => ({buffer: Buffer.from('synthetic-test-image'), mimeType: 'image/png', billing})

function setup(expectedOutputs = 1) {
  const settings = createDefaultSettings('openai/gpt-image-2')
  const env: any = {body: {prompt: 'Edit this product', model: 'openai/gpt-image-2', settings: {...settings, numberOfImages: expectedOutputs}, inputImages: ['/images/input/product.png'], modelImages: []},
    dbScopes: [], storageScopes: [], gatewayInitializations: [], rows: new Map<number, any>(), failures: [], completions: [],
    sourceChecks: [], saves: [], removals: [], gatewayRequests: [], providerCalls: 0, extraPendingCalls: 0, closeCount: 0, outputs: [image()], generatedReferences: [], postedCharges: [], peopleChecks: [], pendingData: [],
  }
  let nextId = 1
  function pending(data: any) {
    env.pendingData.push(data)
    const value = {id: nextId++, TextPrompt: data.prompt, status: 'pending', outputImage: '', priceUsd: null, priceSource: null, billingState: 'awaiting', generationModel: data.effectiveModel, personId: data.personId ?? null, ...actor}
    env.rows.set(value.id, value)
    return value
  }
  function transition(id: number, status: string, data: any) {
    const value = env.rows.get(id)
    if (!value) throw new Error('Unknown fixture generation')
    if (value.status !== 'pending') return {row: value, transitioned: false}
    const billing = data.billing ?? {}
    Object.assign(value, {status, outputImage: data.outputImage ?? '', errors: data.error?.message ?? null,
      priceUsd: billing.priceUsd ?? null, priceSource: billing.priceSource ?? null, gatewayGenerationId: billing.gatewayGenerationId ?? null,
      billingState: billing.priceSource === 'gateway' && parseUsdUnits(billing.priceUsd) !== undefined ? 'confirmed' : 'awaiting', usageJson: billing.usageJson ?? null})
    if (value.billingState === 'confirmed') env.postedCharges.push({id, units: parseUsdUnits(value.priceUsd)})
    return {row: value, transitioned: true}
  }
  env.database = {
    getSystemPrompt: async (id: number) => env.rows.get(id), getExpiredGeneratedImagePaths: async () => [], reconcileStalePendingGenerations: async () => 0,
    createPendingGenerations: async (items: any[]) => {if (env.admissionError) throw env.admissionError; return items.map(pending)},
    createPendingGeneration: async (data: any) => {env.extraPendingCalls += 1; if (env.failExtraPendingAt === env.extraPendingCalls) throw new Error('Additional output row persistence failed'); return pending(data)},
    completeGeneration: async (id: number, data: any) => {env.completions.push({id, data}); return transition(id, 'succeeded', data)},
    failGeneration: async (id: number, data: any) => {env.failures.push({id, data}); return transition(id, 'failed', data)},
  }
  env.storage = {
    assertReadableImages: async (paths: string[]) => {env.sourceChecks.push(paths)},
    saveGeneratedImage: async (buffer: Buffer, mimeType: string) => {assert.ok(buffer.byteLength > 0); env.saves.push({bytes: buffer.byteLength, mimeType}); return {url: `/images/output/result-${env.saves.length}.png`, mimeType, bytes: buffer.byteLength, width: 640, height: 800}},
    removeGeneratedImage: async (url: string) => {env.removals.push(url)},
  }
  env.gateway = {generateAnyImage: async (body: any, signal: AbortSignal, onProviderStart?: () => void) => {
    env.gatewayRequests.push(body); assert.equal(signal.aborted, false)
    if (env.preCallError) throw env.preCallError
    onProviderStart?.(); env.providerCalls += 1
    if (env.paidError) throw env.paidError
    const generated = env.outputs.map((output: any) => ({...output}))
    env.generatedReferences.push(...generated)
    return generated
  }}
  const signal = new AbortController().signal
  env.reservation = {signal, withMemorySlot: async (task: any) => task(signal), run: async (_index: number, task: any) => task(signal), close: async () => {env.closeCount += 1}}
  ;(globalThis as any)[key] = env
  return env
}

test('generation handler releases only confirmed output URLs and preserves pending estimated outputs internally', async () => {
  for (const source of ['gateway', 'estimate'] as const) {
    const env = setup()
    env.outputs = [image(billed(source, source === 'gateway' ? '0.000000000000' : '0.050000000000'))]
    const response = await handler(event())
    assert.equal(response.obj[0]!.status, 'succeeded')
    assert.equal(response.obj[0]!.outputImage, source === 'gateway' ? '/images/output/result-1.png' : null)
    assert.equal(env.rows.get(1).outputImage, '/images/output/result-1.png')
    assert.equal(env.rows.get(1).priceSource, source)
    assert.deepEqual(env.dbScopes, [actor])
    assert.deepEqual(env.storageScopes, [actor])
    assert.deepEqual(env.sourceChecks, [['/images/input/product.png']])
    assert.equal(env.requestLimit, 512 * 1024)
    assert.equal(env.providerCalls, 1)
    assert.equal(env.closeCount, 1)
    assert.equal(env.generatedReferences[0].buffer.byteLength, 0)
  }
})

test('credit admission preserves 402 and 409 before any paid provider call or output storage', async () => {
  for (const statusCode of [402, 409]) {
    const env = setup()
    env.admissionError = createError({statusCode, statusMessage: statusCode === 402 ? 'Credit exhausted' : 'Previous price is outstanding'})
    await assert.rejects(() => handler(event()), (error: any) => error.statusCode === statusCode)
    assert.equal(env.gatewayRequests.length, 0)
    assert.equal(env.providerCalls, 0)
    assert.equal(env.saves.length, 0)
    assert.equal(env.rows.size, 0)
    assert.equal(env.closeCount, 1)
  }
})

test('people factory creates independent jobs with durable profile links and normal exact billing', async () => {
  const env = setup()
  const personId = '8687c1db-3ca9-411c-a89b-e4c70c67f632'
  env.body = {...env.body, inputImages: [], modelImages: ['/images/input/person-reference.png'], personId, personPictureCount: 3}
  const response = await handler(event())
  assert.equal(env.providerCalls, 3)
  assert.equal(env.reservationArguments[1], 3)
  assert.deepEqual(env.peopleChecks, [{actor, id: personId}])
  assert.deepEqual(env.sourceChecks, [['/images/input/person-reference.png']])
  assert.equal(env.pendingData.length, 3)
  assert.ok(env.pendingData.every((value: any) => value.personId === personId && value.inputImages.length === 0
    && value.modelImages[0] === '/images/input/person-reference.png'))
  assert.ok(env.gatewayRequests.every((value: any) => value.inputImages.length === 0 && value.modelImages[0] === '/images/input/person-reference.png'))
  assert.equal(response.summary.succeeded, 3)
  assert.ok(response.obj.every((value: any) => value.personId === personId && value.outputImage))
  assert.equal(env.postedCharges.reduce((sum: bigint, charge: any) => sum + charge.units, 0n), parseUsdUnits('0.090000000001')! * 3n)
})

test('people ownership and picture bounds reject before pending rows and paid provider calls', async () => {
  const personId = '8687c1db-3ca9-411c-a89b-e4c70c67f632'
  for (const changed of [
    {personId, personPictureCount: 0, inputImages: []}, {personId, personPictureCount: 5, inputImages: []},
    {personPictureCount: 2, inputImages: []}, {personId, personPictureCount: 2},
    {personId, personPictureCount: 3, inputImages: [], settings: {...createDefaultSettings('openai/gpt-image-2'), numberOfImages: 2}},
  ]) {
    const env = setup()
    Object.assign(env.body, changed)
    await assert.rejects(() => handler(event()), (error: any) => error.statusCode === 400)
    assert.equal(env.providerCalls, 0)
    assert.equal(env.rows.size, 0)
  }
  const env = setup()
  env.body = {...env.body, inputImages: [], personId, personPictureCount: 2}
  env.personError = createError({statusCode: 404, statusMessage: 'Person not found'})
  await assert.rejects(() => handler(event()), (error: any) => error.statusCode === 404)
  assert.equal(env.providerCalls, 0)
  assert.equal(env.rows.size, 0)
  assert.equal(env.gatewayInitializations.length, 0)
})

test('people factory retains pending unpriced images without exposing their URLs', async () => {
  const env = setup()
  env.body = {...env.body, inputImages: [], personId: '8687c1db-3ca9-411c-a89b-e4c70c67f632', personPictureCount: 2}
  env.outputs = [image(billed('estimate', '0.030000000000'))]
  const response = await handler(event())
  assert.equal(env.providerCalls, 2)
  assert.ok(response.obj.every((value: any) => value.outputImage === null))
  assert.ok([...env.rows.values()].every((value: any) => value.personId === env.body.personId && value.outputImage))
  assert.equal(env.postedCharges.length, 0)
})

test('an error before the provider-start callback releases every pending charge without inventing a billed call', async () => {
  const env = setup(2)
  env.preCallError = createError({statusCode: 400, statusMessage: 'Source image validation failed'})
  const response = await handler(event())
  assert.equal(response.summary.failed, 2)
  assert.equal(env.providerCalls, 0)
  assert.equal(env.failures.length, 2)
  assert.ok(env.failures.every((failure: any) => failure.data.releaseCharge === true && !failure.data.billing.priceUsd && !failure.data.billing.gatewayGenerationId))
  assert.equal(env.saves.length, 0)
  assert.equal(env.closeCount, 1)
})

test('fewer returned images allocate the full actual cost to produced outputs and release unproduced placeholders', async () => {
  const env = setup(3)
  env.outputs = [image(billed('gateway', '0.090000000001'))]
  const response = await handler(event())
  assert.deepEqual(response.summary, {requested: 3, total: 3, succeeded: 1, failed: 2})
  assert.equal(env.completions.length, 1)
  assert.equal(env.completions[0].data.billing.priceUsd, '0.090000000001')
  assert.equal(env.completions[0].data.billing.gatewayGenerationId, 'gen_test_charge')
  assert.equal(env.failures.length, 2)
  assert.ok(env.failures.every((failure: any) => failure.data.releaseCharge === true && !failure.data.billing.priceUsd && !failure.data.billing.gatewayGenerationId))
  assert.equal(env.providerCalls, 1)
  assert.equal(env.saves.length, 1)
})

test('failure creating extra output rows preserves one full provider price allocated across every tracked failed row', async () => {
  const env = setup(1)
  env.outputs = [image(), image(), image()]
  env.failExtraPendingAt = 2
  const response = await handler(event())
  assert.deepEqual(response.summary, {requested: 1, total: 2, succeeded: 0, failed: 2})
  assert.equal(env.failures.length, 2)
  assert.equal(env.providerCalls, 1)
  assert.equal(env.saves.length, 0)
  assert.ok(env.failures.every((failure: any) => failure.data.releaseCharge === false && failure.data.billing.gatewayGenerationId === 'gen_test_charge'))
  const total = env.failures.reduce((sum: bigint, failure: any) => sum + parseUsdUnits(failure.data.billing.priceUsd)!, 0n)
  assert.equal(total, parseUsdUnits('0.090000000001'))
  assert.deepEqual(env.failures.map((failure: any) => failure.data.billing.usageJson.allocation), [
    {outputIndex: 0, outputCount: 2, method: 'equal-share'}, {outputIndex: 1, outputCount: 2, method: 'equal-share'},
  ])
  assert.ok(env.generatedReferences.every((output: any) => output.buffer.byteLength === 0))
  assert.equal(env.closeCount, 1)
})

test('a paid failure with no images retains its exact Gateway price and accounting identity across failed outputs', async () => {
  const env = setup(2)
  env.paidError = createError({statusCode: 502, statusMessage: 'Provider returned no images', data: {details: {billing: billed('gateway', '0.120000000001')}}})
  const response = await handler(event())
  assert.equal(response.summary.failed, 2)
  assert.equal(env.providerCalls, 1)
  assert.equal(env.saves.length, 0)
  assert.ok(env.failures.every((failure: any) => failure.data.releaseCharge === false && failure.data.billing.gatewayGenerationId === 'gen_test_charge'))
  const total = env.failures.reduce((sum: bigint, failure: any) => sum + parseUsdUnits(failure.data.billing.priceUsd)!, 0n)
  assert.equal(total, parseUsdUnits('0.120000000001'))
  assert.ok(response.obj.every((value: any) => value.outputImage === '' || value.outputImage === null))
  assert.equal(env.closeCount, 1)
})

test('an infrastructure repair retry preserves the paid allocation while leaving a successful sibling and its charge unchanged', async () => {
  const env = setup(2)
  env.outputs = [image(), image()]
  const save = env.storage.saveGeneratedImage
  let saveAttempts = 0
  env.storage.saveGeneratedImage = async (...args: any[]) => {
    if (++saveAttempts === 2) throw new Error('Second output storage failed')
    return save(...args)
  }
  const fail = env.database.failGeneration
  let transientFailures = 2
  const rejectedRepairs: Array<{id: number; data: any}> = []
  env.database.failGeneration = async (id: number, data: any) => {
    if (id === 2 && transientFailures > 0) {
      transientFailures -= 1
      rejectedRepairs.push({id, data})
      throw new Error('Temporary terminal-row write failure')
    }
    return fail(id, data)
  }
  const errors: string[] = []
  const previousError = console.error
  console.error = (...args: any[]) => {errors.push(String(args[0]))}
  try {
    const response = await handler(event())
    assert.deepEqual(response.summary, {requested: 2, total: 2, succeeded: 1, failed: 1})
    assert.ok(errors.some(message => message.includes('Generation job rejected; attempting terminal repair')))
    assert.equal(rejectedRepairs.length, 2)
    assert.equal(env.providerCalls, 1)
    assert.equal(env.rows.get(1).status, 'succeeded')
    assert.equal(env.rows.get(1).outputImage, '/images/output/result-1.png')
    assert.equal(env.rows.get(1).priceUsd, '0.045000000001')
    assert.equal(env.rows.get(2).status, 'failed')
    assert.equal(env.rows.get(2).priceUsd, '0.045000000000')
    assert.equal(env.rows.get(2).gatewayGenerationId, 'gen_test_charge')
    const repaired = env.failures.find((failure: any) => failure.id === 2)
    assert.equal(repaired.data.releaseCharge, false)
    assert.deepEqual(repaired.data.billing.usageJson.allocation, {outputIndex: 1, outputCount: 2, method: 'equal-share'})
    assert.equal(env.postedCharges.length, 2)
    assert.deepEqual(env.postedCharges.map((charge: any) => charge.id), [1, 2])
    assert.equal(env.postedCharges.reduce((sum: bigint, charge: any) => sum + charge.units, 0n), parseUsdUnits('0.090000000001'))
    assert.deepEqual(env.removals, [])
    assert.ok(env.generatedReferences.every((output: any) => output.buffer.byteLength === 0))
    assert.equal(env.closeCount, 1)
  } finally {console.error = previousError}
})
