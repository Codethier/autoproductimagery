import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {computed, createSSRApp, h, ref} from 'vue'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createFetch} from 'ofetch'
import {fetchStatusCode, prepareServerlessRequest, serverlessFetchOptions, SERVERLESS_READ_BUDGET_MS, SERVERLESS_READ_ATTEMPT_MS, SERVERLESS_MUTATION_TIMEOUT_MS} from '../app/utils/serverlessRequests.ts'

const errorPage = new URL('../app/error.vue', import.meta.url).href
const errorStateKey = '__serverlessErrorUi'
registerHooks({load(url, context, next) {
  if (url !== errorPage) return next(url, context)
  const filename = fileURLToPath(url)
  const source = readFileSync(filename, 'utf8').replace('</script>', 'defineExpose({retry, retryPath, warmup})\n</script>')
  const {descriptor} = parse(source, {filename})
  const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
  return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed} from 'vue';const clearError=value=>globalThis.${errorStateKey}.clear(value);const useHead=()=>{};${compiled.content}`)}
}})

test('safe reads share a 90-second deadline across retries while preserving cancellation and the account epoch', context => {
  let now = 1000
  context.mock.method(Date, 'now', () => now)
  const external = new AbortController()
  const options: any = {signal: external.signal, timeout: 20_000, retry: 8}
  prepareServerlessRequest(options, 4)
  assert.equal(options.timeout, SERVERLESS_READ_ATTEMPT_MS)
  assert.equal(options.retry, 1)
  assert.equal(options.workspaceRequestState.budget, SERVERLESS_READ_BUDGET_MS)
  assert.equal(options.workspaceAccountEpoch, 4)
  const first = options.signal
  const deadline = options.workspaceRequestState.deadline
  now += 60_000
  options.retry = 0 // ofetch decrements this before the retry's hook.
  prepareServerlessRequest(options, 5)
  assert.equal(options.timeout, 30_000)
  assert.equal(options.retry, 0)
  assert.equal(options.workspaceRequestState.deadline, deadline)
  assert.equal(options.workspaceAccountEpoch, 4)
  assert.notEqual(options.signal, first)
  external.abort()
  assert.equal(first.aborted, true)
  assert.equal(options.signal.aborted, true)
  prepareServerlessRequest(options, 5)
  assert.equal(options.retry, 0)
  now += 30_000
  prepareServerlessRequest(options)
  assert.equal(options.timeout, 0)
  assert.equal(options.signal.aborted, true, 'an exhausted budget cannot begin a further request')
})

test('mutations tolerate database and runner warm-up, preserve longer paid deadlines, and cannot automatically replay', context => {
  context.mock.method(Date, 'now', () => 1000)
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const external = new AbortController()
    const options: any = {method, timeout: 20_000, signal: external.signal, retry: 5}
    prepareServerlessRequest(options, 2)
    assert.equal(options.retry, 0)
    assert.equal(options.timeout, SERVERLESS_MUTATION_TIMEOUT_MS)
    assert.ok(options.timeout >= 60_000 + 75_000 + 20_000, 'database acquisition, runner wake and normal admission work fit the bounded deadline')
    external.abort()
    assert.equal(options.signal.aborted, true)
  }
  const paid: any = {method: 'POST', timeout: 600_000}
  prepareServerlessRequest(paid)
  assert.equal(paid.timeout, 600_000)
  assert.equal(paid.workspaceRequestState.budget, 600_000)
  assert.equal(paid.retry, 0)
})

test('real ofetch recovers one transient read failure but never repeats an uncertain mutation or a refused account request', async () => {
  const calls: Array<{url: string; signal: AbortSignal; state: unknown}> = []
  const transport = createFetch({fetch: (async (url, options: any) => {
    calls.push({url: String(url), signal: options.signal, state: options.workspaceRequestState})
    return new Response(JSON.stringify({ok: true}), {status: calls.length === 1 ? 503 : 200, headers: {'content-type': 'application/json'}})
  }) as typeof fetch})
  assert.deepEqual(await transport('/account', serverlessFetchOptions({}, 7)), {ok: true})
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.state, calls[1]!.state)
  assert.notEqual(calls[0]!.signal, calls[1]!.signal)
  for (const [method, status] of [['POST', 503], ['GET', 401], ['GET', 403], ['GET', 429]] as const) {
    let attempts = 0
    const denied = createFetch({fetch: (async () => {attempts++; return new Response('{}', {status})}) as typeof fetch})
    await assert.rejects(denied('/private', serverlessFetchOptions({method, retry: 9})))
    assert.equal(attempts, 1, `${method} ${status} must not be retried`)
  }
})

test('image uploads keep a 240-second deadline and caller cancellation without automatically replaying uncertain stored files', async context => {
  context.mock.method(Date, 'now', () => 1000)
  const external = new AbortController()
  const body = new FormData()
  body.append('path', '/')
  body.append('files', new File(['image bytes'], 'sample.png', {type: 'image/png'}))
  let attempts = 0
  let observed: any
  const transport = createFetch({fetch: (async (_url, options: any) => {
    attempts++; observed = options
    return new Response('{}', {status: 503})
  }) as typeof fetch})
  await assert.rejects(transport('/api/upload', serverlessFetchOptions({method: 'POST', body, timeout: 240_000, retry: 0, signal: external.signal})))
  assert.equal(attempts, 1)
  assert.equal(observed.body, body)
  assert.equal(observed.timeout, 240_000)
  assert.equal(observed.workspaceRequestState.budget, 60_000 + 120_000 + 60_000)
  assert.equal(observed.retry, 0)
  assert.equal(observed.signal.aborted, false)
  external.abort()
  assert.equal(observed.signal.aborted, true)
})

test('an attempt timeout replaces its aborted signal for the read retry while preserving the overall deadline', async context => {
  const deadlines: Array<{milliseconds: number; controller: AbortController}> = []
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController()
    deadlines.push({milliseconds, controller})
    return controller.signal
  })
  let attempts = 0
  const transport = createFetch({fetch: (async (_url, options: any) => {
    attempts++
    if (attempts === 1) {
      deadlines[1]!.controller.abort(new DOMException('Initial service request timed out', 'TimeoutError'))
      throw options.signal.reason
    }
    assert.equal(options.signal.aborted, false)
    return new Response('{"ready":true}', {headers: {'content-type': 'application/json'}})
  }) as typeof fetch})
  assert.deepEqual(await transport('/api/account/me', serverlessFetchOptions({})), {ready: true})
  assert.equal(attempts, 2)
  assert.deepEqual(deadlines.map(value => value.milliseconds), [90_000, 45_000, 45_000])
  assert.equal(deadlines[0]!.controller.signal.aborted, false)
})

function routeFixture(load: () => Promise<unknown>) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../app/middleware/auth.global.ts', import.meta.url), 'utf8'))
    .replace(/import \{fetchStatusCode\} from '[^']+'/, '')
    .replace('export default defineNuxtRouteMiddleware', 'return defineNuxtRouteMiddleware')
  let clears = 0, aborts = 0
  const navigations: string[] = []
  const session = {account: ref<unknown>(null), epoch: ref(1), load, clear() {clears++; this.epoch.value++; this.account.value = null}}
  const createError = (value: unknown) => value
  const guard = new Function('defineNuxtRouteMiddleware', 'useAccount', 'fetchStatusCode', 'createError', 'navigateTo', 'abortNavigation', source)
    ((callback: unknown) => callback, () => session, fetchStatusCode, createError, (path: string) => {navigations.push(path)}, () => {aborts++; return false})
  return {guard, session, navigations, get clears() {return clears}, get aborts() {return aborts}}
}

test('cold-start account failures retain the session and route, with a retryable warm-up error rather than a sign-in redirect', async () => {
  for (const failure of [{statusCode: 503}, {status: 504}, new DOMException('Timed out', 'TimeoutError'), new Error('Network unavailable')]) {
    const value = routeFixture(async () => {throw failure})
    await assert.rejects(value.guard({path: '/pipelines', fullPath: '/pipelines?run=test'}), (error: any) => {
      assert.equal(error.statusCode, 503)
      assert.deepEqual(error.data, {workspaceWarmup: true, retryPath: '/pipelines?run=test'})
      return true
    })
    assert.equal(value.clears, 0)
    assert.equal(value.session.epoch.value, 1)
    assert.deepEqual(value.navigations, [])
  }
})

test('only a current confirmed 401 redirects to sign-in; late prior-account failures cannot clear a new account', async () => {
  const denied = routeFixture(async () => {throw {response: {status: 401}}})
  await denied.guard({path: '/assets', fullPath: '/assets?folder=test'})
  assert.equal(denied.clears, 1)
  assert.deepEqual(denied.navigations, ['/login?redirect=%2Fassets%3Ffolder%3Dtest'])
  let fail!: (error: unknown) => void
  const late = routeFixture(() => new Promise((_resolve, reject) => {fail = reject}))
  const pending = late.guard({path: '/assets', fullPath: '/assets'})
  late.session.epoch.value++
  late.session.account.value = {userId: 'new-user'}
  fail({status: 401})
  await pending
  assert.equal(late.clears, 0)
  assert.equal(late.aborts, 1)
  assert.deepEqual(late.navigations, [])
})

test('the warm-up recovery screen explains the retained session and retries only an internal workspace route', async () => {
  const {default: Page} = await import(errorPage)
  for (const path of ['/pipelines?run=123', '//external.test', 'https://external.test', '/\\external.test', '/assets\u0000']) {
    const redirects: unknown[] = []
    ;(globalThis as any)[errorStateKey] = {clear: async (value: unknown) => {redirects.push(value)}}
    let exposed: any
    const actual = {...Page, setup(props: unknown, context: any) {return Page.setup(props, {...context, expose(value: unknown) {exposed = value; context.expose(value)}})}}
    const app = createSSRApp({render: () => h(actual, {error: {statusCode: 503, data: {workspaceWarmup: true, retryPath: path}}})})
    const html = await renderToString(app)
    assert.match(html, /Your workspace is waking up/)
    assert.match(html, /Your session is preserved/)
    assert.match(html, /<button[^>]*type="button"[^>]*>Try again<\/button>/)
    assert.doesNotMatch(html, /Sign in|username|password|external\.test/)
    await exposed.retry()
    assert.deepEqual(redirects, [{redirect: path === '/pipelines?run=123' ? path : '/edit'}])
  }
})
