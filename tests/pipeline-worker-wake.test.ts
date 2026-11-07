import test from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {createServer} from 'node:http'
import {getPipelineWorkerWakeConfig, pipelineWorkerWakeToken, isPipelineWorkerWakeAuthorized,
    createPipelineWorkerWakeDispatcher} from '../server/utils/pipelineWorkerWake.ts'
import {createPipelineWorkerHttpHandler} from '../server/utils/pipelineWorkerHttp.ts'

const environment = {NUXT_AI_GATEWAY_API_KEY: 'invalid-local-test-key-no-provider-calls'}
const config = () => getPipelineWorkerWakeConfig({...environment, PIPELINE_WORKER_URL: 'http://127.0.0.1:3221'})
function gate<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(done => {resolve = done})
    return {promise, resolve}
}

test('wake configuration uses Railway private HTTP and a domain-separated credential, with safe explicit overrides', () => {
    assert.equal(getPipelineWorkerWakeConfig(environment), undefined)
    const railway = getPipelineWorkerWakeConfig({...environment, RAILWAY_ENVIRONMENT_ID: 'test-environment'})!
    assert.equal(railway.url, 'http://pipeline-worker.railway.internal:8080/wake')
    assert.equal(railway.token, createHmac('sha256', environment.NUXT_AI_GATEWAY_API_KEY)
        .update('autoproductimagery:pipeline-worker-wake:v1').digest('hex'))
    assert.notEqual(railway.token, environment.NUXT_AI_GATEWAY_API_KEY)
    assert.equal(getPipelineWorkerWakeConfig({...environment, PIPELINE_WORKER_URL: 'https://runner.example/wake'})?.url,
        'https://runner.example/wake')
    assert.equal(getPipelineWorkerWakeConfig({...environment, PIPELINE_WORKER_URL: 'http://[::1]:3000'})?.url,
        'http://[::1]:3000/wake')
    const explicit = {PIPELINE_WORKER_WAKE_SECRET: 'a'.repeat(32)}
    assert.notEqual(pipelineWorkerWakeToken({...environment, ...explicit}), railway.token)
    assert.equal(pipelineWorkerWakeToken(explicit), pipelineWorkerWakeToken({...environment, ...explicit}))
    for (const value of ['http://public.example', 'file:///tmp/secret', 'https://user:pass@example.test',
        'https://example.test/?token=secret', 'https://example.test/#secret', 'https://example.test/arbitrary']) {
        assert.throws(() => getPipelineWorkerWakeConfig({...environment, PIPELINE_WORKER_URL: value}), /URL is invalid/)
    }
    assert.throws(() => getPipelineWorkerWakeConfig({PIPELINE_WORKER_URL: 'https://runner.example'}), /credentials are missing/)
    assert.throws(() => pipelineWorkerWakeToken({...environment, PIPELINE_WORKER_WAKE_SECRET: 'short'}), /credentials are invalid/)
})

test('wake authentication requires the derived bearer token and never accepts raw provider credentials', () => {
    const token = pipelineWorkerWakeToken(environment)!
    assert.equal(isPipelineWorkerWakeAuthorized(`Bearer ${token}`, token), true)
    for (const authorization of [undefined, '', `Bearer ${environment.NUXT_AI_GATEWAY_API_KEY}`, `Basic ${token}`,
        `Bearer ${'f'.repeat(64)}`, `Bearer ${token}extra`, `Bearer ${token.toUpperCase()}`]) {
        assert.equal(isPipelineWorkerWakeAuthorized(authorization, token), false)
    }
    assert.equal(isPipelineWorkerWakeAuthorized(`Bearer ${token}`, undefined), false)
})

test('cold wake retries only safe empty POST requests and tolerates proxy/startup connection failures', async () => {
    let time = 0, calls = 0, unavailable = 0
    const waits: number[] = []
    const helper = createPipelineWorkerWakeDispatcher({config, now: () => time,
        wait: async ms => {waits.push(ms); time += ms}, unavailable: () => unavailable++,
        fetch: async (url, options) => {
            calls++
            assert.equal(url, 'http://127.0.0.1:3221/wake')
            assert.equal(options?.method, 'POST'); assert.equal(options.body, ''); assert.equal(options.redirect, 'error')
            assert.ok(options.signal instanceof AbortSignal)
            assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${config()!.token}`)
            if (calls === 1) return new Response('private proxy diagnostic', {status: 503})
            if (calls === 2) throw Object.assign(new Error('secret gateway/database URL'), {code: 'ECONNREFUSED'})
            return new Response(null, {status: 202})
        },
    })
    assert.equal(await helper.wake(), 'accepted')
    assert.equal(calls, 3); assert.deepEqual(waits, [500, 1000]); assert.equal(unavailable, 0)
    // A second committed job needs a fresh wake even immediately after an ack.
    assert.equal(await helper.wake(), 'accepted'); assert.equal(calls, 4)
})

test('a newer committed job during an in-flight wake receives another POST after the old acknowledgment', async () => {
    const firstResponse = gate<Response>(), entered = gate()
    let calls = 0
    const helper = createPipelineWorkerWakeDispatcher({config, fetch: async () => {
        if (++calls === 1) {entered.resolve(); return firstResponse.promise}
        return new Response(null, {status: 202})
    }})
    const first = helper.wake()
    await entered.promise
    const second = helper.wake(), third = helper.wake()
    assert.equal(calls, 1)
    firstResponse.resolve(new Response(null, {status: 202}))
    assert.deepEqual(await Promise.all([first, second, third]), ['accepted', 'accepted', 'accepted'])
    assert.equal(calls, 2)
})

test('fast startup refusals do not exhaust retries before a runner that needs forty seconds can become ready', async () => {
    let time = 0, calls = 0
    const helper = createPipelineWorkerWakeDispatcher({config, now: () => time, wait: async ms => {time += ms},
        fetch: async () => {calls++; return new Response(null, {status: time >= 40_000 ? 202 : 503})}})
    assert.equal(await helper.wake({budgetMs: 75_000}), 'accepted')
    assert.ok(time >= 40_000 && time < 75_000); assert.ok(calls > 8 && calls <= 32)
})

test('wake failures remain bounded, redacted and cannot manufacture a successful acknowledgment', async () => {
    let time = 0, calls = 0, logs = 0
    const helper = createPipelineWorkerWakeDispatcher({config, now: () => time, wait: async ms => {time += ms},
        unavailable: () => logs++, fetch: async () => {calls++; return new Response('private details', {status: 503})}})
    assert.equal(await helper.wake({budgetMs: 2500}), 'unavailable')
    assert.equal(time, 2500); assert.equal(calls, 3); assert.equal(logs, 1)
    let denied = 0
    const forbidden = createPipelineWorkerWakeDispatcher({config, fetch: async () => {denied++; return new Response(null, {status: 401})}})
    assert.equal(await forbidden.wake(), 'unavailable'); assert.equal(denied, 1)
    assert.equal(await createPipelineWorkerWakeDispatcher({config: () => undefined,
        fetch: async () => assert.fail('No request without a configured worker')}).wake(), 'not-configured')
})

test('an unresponsive cold wake is aborted at its bounded caller deadline', async () => {
    let aborted = false
    const helper = createPipelineWorkerWakeDispatcher({config, fetch: async (_, options) => new Promise<Response>((_, reject) => {
        options!.signal!.addEventListener('abort', () => {aborted = true; reject(Error('private socket diagnostic'))}, {once: true})
    })})
    const started = Date.now()
    assert.equal(await helper.wake({budgetMs: 100}), 'unavailable')
    assert.equal(aborted, true)
    assert.ok(Date.now() - started < 1000)
})

test('a short status wake deadline never aborts an enqueue wake with a longer shared delivery budget', async () => {
    const response = gate<Response>(), entered = gate()
    let signal: AbortSignal | null | undefined, calls = 0
    const helper = createPipelineWorkerWakeDispatcher({config, fetch: async (_, options) => {
        calls++; signal = options!.signal; entered.resolve(); return response.promise
    }})
    const enqueue = helper.wake({budgetMs: 1000})
    await entered.promise
    assert.equal(await helper.wake({budgetMs: 100}), 'unavailable')
    assert.equal(calls, 1); assert.equal(signal?.aborted, false)
    response.resolve(new Response(null, {status: 202}))
    assert.equal(await enqueue, 'accepted'); assert.equal(signal?.aborted, false)
})

test('worker HTTP wake is authenticated, empty, startup-aware and acknowledges before any durable drain finishes', async () => {
    let ready = false, wakes = 0
    const token = pipelineWorkerWakeToken(environment)!
    const server = createServer(createPipelineWorkerHttpHandler({ready: () => ready, token, wake: () => {wakes++}}))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    try {
        const health = await fetch(`${base}/health`)
        assert.equal(health.status, 503); assert.deepEqual(await health.json(), {ok: false, worker: 'pipelines'})
        assert.equal((await fetch(`${base}/wake`, {method: 'POST'})).status, 401)
        const starting = await fetch(`${base}/wake`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}})
        assert.equal(starting.status, 503); assert.equal(starting.headers.get('retry-after'), '1'); assert.equal(wakes, 0)
        ready = true
        assert.equal((await fetch(`${base}/wake`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: '{}'})).status, 400)
        const accepted = await fetch(`${base}/wake`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: ''})
        assert.equal(accepted.status, 202); assert.equal(accepted.headers.get('cache-control'), 'no-store'); assert.equal(wakes, 1)
        assert.deepEqual(await accepted.json(), {ok: true, worker: 'pipelines'})
        assert.equal((await fetch(`${base}/health`)).status, 200)
        assert.equal((await fetch(`${base}/wake`)).status, 404)
    } finally {await new Promise<void>(resolve => server.close(() => resolve()))}
})
