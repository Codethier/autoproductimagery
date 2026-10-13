import assert from 'node:assert/strict'
import {IncomingMessage, ServerResponse} from 'node:http'
import {Socket} from 'node:net'
import {registerHooks} from 'node:module'
import test from 'node:test'
import {createError, createEvent, defineEventHandler, getQuery} from 'h3'

const root = new URL('../', import.meta.url)
const actor = {organizationId: 'org-alice', userId: 'alice'}
const environmentKey = '__billingApiTest'
const dependency = (path: string) => new URL(path, root).href
const mocks = new Map([
  [dependency('server/utils/useDB.ts'), `export const useDB = async (_db, actor) => globalThis.${environmentKey}.db(actor);`],
  [dependency('server/utils/generationLimiter.ts'), 'export const getGenerationRuntimeSettings = () => ({staleTtlMs: 300000});'],
  [dependency('server/utils/reconcilePendingAccountBilling.ts'), `
    export const refreshPendingAccountBilling = async actor => globalThis.${environmentKey}.reconcile(actor);
    export const reconcilePendingAccountBilling = async (actor, options) => globalThis.${environmentKey}.reconcile(actor, options);`],
  [dependency('server/utils/accountBilling.ts'), `export const createAccountBilling = () => ({balanceFor: async actor => globalThis.${environmentKey}.balance(actor)});`],
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
Object.assign(globalThis, {defineEventHandler, createError, getQuery, useRuntimeConfig: () => ({}), useAuth: async () => actor})
const history = (await import('../server/api/systemprompts.get.ts')).default
const detail = (await import('../server/api/systemprompts/[id].get.ts')).default
const refresh = (await import('../server/api/systemprompts/[id]/billing-refresh.post.ts')).default
const logs = (await import('../server/api/ai-gateway-logs.get.ts')).default
const balance = (await import('../server/api/account/balance.get.ts')).default

const image = (id: number) => `/images/output/private-${id}.png`
const row = (id: number, fields: Record<string, unknown> = {}) => ({id, TextPrompt: `Product ${id}`, status: 'succeeded', outputImage: image(id),
  priceUsd: null, priceSource: null, billingState: 'awaiting', gatewayGenerationId: `gen_${id}`, ...fields})
function event(id = '1', url = '/api/systemprompts') {
  const request = new IncomingMessage(new Socket())
  request.url = url; request.method = 'GET'; request.headers = {host: 'localhost'}
  const response = new ServerResponse(request)
  const value = createEvent(request, response)
  value.context.params = {id}
  return value
}
function setup(rows: any[] = []) {
  const scopes: unknown[] = [], reconciliations: unknown[] = [], order: string[] = []
  const env: any = {rows, scopes, reconciliations, order, logRows: [], visibility: rows,
    async reconcile(account: unknown, options?: unknown) {reconciliations.push({account, options}); order.push('reconcile'); await env.onReconcile?.()},
    async balance(account: unknown) {assert.deepEqual(account, actor); order.push('balance'); return {currency: 'USD', actualBalanceUsd: null, unlimited: true}},
    db(account: unknown) {scopes.push(account); return {
      reconcileStalePendingGenerations: async () => 0,
      getSystemPrompts: async () => env.rows, countSystemPrompts: async () => env.rows.length,
      getSystemPrompt: async (id: number) => env.rows.find((entry: any) => entry.id === id),
      getAiGatewayLogs: async () => env.logRows,
      getGenerationBillingVisibility: async (ids: number[]) => {assert.ok(ids.length <= 200); return env.visibility.filter((entry: any) => ids.includes(entry.id))},
    }},
  }
  ;(globalThis as any)[environmentKey] = env
  return env
}

test('history and detail endpoints never expose pending, estimated or BYOK output paths, while exact zero is visible', async () => {
  const env = setup([row(1), row(2, {priceUsd: '0.000000000000', priceSource: 'gateway', billingState: 'confirmed'}),
    row(3, {priceUsd: '0.050000000000', priceSource: 'estimate'}),
    row(4, {priceUsd: '0.020000000000', priceSource: 'gateway', billingState: null, usageJson: {gatewayBilling: {isByok: true}}})])
  const request = event()
  const result = await history(request)
  assert.equal(request.node.res.getHeader('cache-control'), 'no-store')
  assert.deepEqual(result.items.map(item => item.outputImage), [null, image(2), null, null])
  assert.deepEqual(env.scopes, [actor])
  assert.deepEqual(env.reconciliations, [{account: actor, options: undefined}])
  const pending = await detail(event('1'))
  assert.equal(pending.item.outputImage, null)
  const confirmed = await detail(event('2'))
  assert.equal(confirmed.item.outputImage, image(2))
  await assert.rejects(() => detail(event('999')), (error: any) => error.statusCode === 404)
})

test('manual price refresh keeps pending results locked and confirmed results immutable without another lookup', async () => {
  const env = setup([row(1)])
  await assert.rejects(() => refresh(event('1')), (error: any) => error.statusCode === 425 && !error.message.includes(image(1)))
  assert.deepEqual(env.reconciliations[0], {account: actor, options: {generationId: 1, limit: 1, lookupTimeoutMs: 10_000}})
  env.onReconcile = () => {env.rows[0] = row(1, {priceUsd: '0.000000000001', priceSource: 'gateway', billingState: 'confirmed'})}
  const confirmed = await refresh(event('1'))
  assert.equal(confirmed.item.outputImage, image(1))
  assert.equal(confirmed.item.priceUsd, '0.000000000001')
  const lookups = env.reconciliations.length
  const unchanged = await refresh(event('1'))
  assert.equal(unchanged.item.priceUsd, confirmed.item.priceUsd)
  assert.equal(env.reconciliations.length, lookups)
  await assert.rejects(() => refresh(event('999')), (error: any) => error.statusCode === 404)
})

test('Gateway diagnostics hide outputs unless the associated scoped generation has a confirmed final price', async () => {
  const env = setup([row(1), row(2, {priceUsd: '0.000000000000', priceSource: 'gateway', billingState: 'confirmed'})])
  env.logRows = [{id: 1, systemPromptId: 1, outputImage: image(1)}, {id: 2, systemPromptId: 2, outputImage: image(2)},
    {id: 3, systemPromptId: 999, outputImage: '/images/other-user.png'}, {id: 4, systemPromptId: null, outputImage: '/images/orphan.png'}]
  const result = await logs(event('1', '/api/ai-gateway-logs?limit=50'))
  assert.deepEqual(result.items.map(item => item.outputImage), [null, image(2), null, null])
  assert.deepEqual(env.scopes, [actor])
})

test('own account balance waits for bounded price reconciliation before returning current credit', async () => {
  const env = setup()
  const request = event()
  const result = await balance(request)
  assert.equal(result.unlimited, true)
  assert.deepEqual(env.order, ['reconcile', 'balance'])
  assert.equal(request.node.res.getHeader('cache-control'), 'no-store')
})
