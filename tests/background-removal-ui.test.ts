import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createRenderer, createSSRApp, h, nextTick, ref} from 'vue'
import type {BackgroundRemovalJob} from '../schemas/background-removal.ts'

const root = new URL('../', import.meta.url)
const panelUrl = new URL('app/components/BackgroundRemovalPanel.vue', root).href
const key = '__backgroundRemovalUiTest'
registerHooks({
  load(url, context, nextLoad) {
    if (url !== panelUrl) return nextLoad(url, context)
    const filename = fileURLToPath(url)
    const source = readFileSync(filename, 'utf8').replace('</script>', 'defineExpose({model, jobs, start, loadJobs, pollJobs, resume, canStart, historyReady, loading, errorMessage, submitting, sources, pollingPaused})\n</script>')
    const {descriptor} = parse(source, {filename})
    const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
    return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed, ref, watch, onMounted, onBeforeUnmount} from 'vue';
      const useAccount = () => globalThis.${key}.account;
      const useRequestFetch = () => (...args) => globalThis.${key}.fetch(...args);
      ${compiled.content}`)}
  },
})

const source = '/images/organizations/org/users/alice/objects/photo/product.png'
const secondSource = '/images/organizations/org/users/alice/objects/photo/second.png'
const output = '/images/organizations/org/users/alice/cutouts/result.png'
function job(overrides: Partial<BackgroundRemovalJob> = {}): BackgroundRemovalJob {
  return {id: 'job-1', sourceUrl: source, model: 'birefnet-lite', modelVersion: 'rembg-birefnet-general-lite-232', status: 'queued', attempts: 0, outputAssetId: null, outputUrl: null, providerPriceUsd: '0', priceSource: 'local-processing', error: null, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', startedAt: null, completedAt: null, ...overrides}
}
function environment(fetch?: (url: string, options: any) => unknown) {
  const calls: Array<{url: string; options: any}> = []
  return {account: {epoch: ref(1), identity: ref('org.alice')}, calls, fetch: async (url: string, options: any) => {calls.push({url, options}); return fetch ? fetch(url, options) : {jobs: []}}}
}
async function renderPanel(options: {sources?: string[]; jobs?: BackgroundRemovalJob[]; env?: ReturnType<typeof environment>; model?: 'birefnet-lite' | 'birefnet'} = {}) {
  const env = options.env ?? environment()
  ;(globalThis as any)[key] = env
  const {default: Panel} = await import(panelUrl)
  let exposed: any
  const originalSetup = Panel.setup
  const component = {...Panel, setup(props: unknown, context: any) {return originalSetup(props, {...context, expose(value: any) {exposed = value; value.jobs.value = options.jobs ?? []; value.historyReady.value = true; value.model.value = options.model ?? 'birefnet-lite'; context.expose(value)}})}}
  const events: Array<{name: string; value: unknown}> = []
  const app = createSSRApp({render: () => h(component, {sourceUrls: options.sources ?? [source], onCompleted: (value: unknown) => events.push({name: 'completed', value}), 'onUse-output': (value: unknown) => events.push({name: 'use-output', value})})})
  app.component('UIcon', {render: () => h('span', {'aria-hidden': 'true'})})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [])
  return {html, exposed, env, events}
}

type Node = {tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, any>; [key: string]: any}
function node(tag: string, text = ''): Node {
  const value: Node = {tag, text, children: [], parent: null, props: {}, tagName: tag.toUpperCase(), addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, getAttribute: (name: string) => value.props[name]}
  return value
}
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(value, parent, anchor) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(value); else parent.children.splice(index, 0, value); value.parent = parent},
  remove(value) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); value.parent = null},
  setText(value, text) {value.text = text}, setElementText(value, text) {value.text = text; value.children = []},
  parentNode: value => value.parent, nextSibling: value => value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null,
  patchProp(value, key, _previous, next) {value.props[key] = next; value[key] = next},
})
const descendants = (value: Node): Node[] => [value, ...value.children.flatMap(descendants)]
async function mountPanel(env: ReturnType<typeof environment>, sources = [source]) {
  ;(globalThis as any)[key] = env
  ;(globalThis as any).HTMLElement = class {}
  ;(globalThis as any).document = {activeElement: null, visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}}
  ;(globalThis as any).window = {addEventListener: () => {}, removeEventListener: () => {}}
  const {default: Panel} = await import(panelUrl)
  let exposed: any
  const originalSetup = Panel.setup
  const component = {...Panel, setup(props: unknown, context: any) {return originalSetup(props, {...context, expose(value: any) {exposed = value; context.expose(value)}})}}
  const events: BackgroundRemovalJob[] = []
  const app = renderer.createApp({render: () => h(component, {sourceUrls: sources, onCompleted: (value: BackgroundRemovalJob) => events.push(value)})})
  app.component('UIcon', {render: () => h('span')})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const tree = node('root'); app.mount(tree); await nextTick(); await nextTick()
  assert.deepEqual(warnings, [])
  return {app, exposed, tree, events}
}

test('local background removal offers only the two explicit CPU models and a known provider charge', async () => {
  const panel = await renderPanel()
  assert.match(panel.html, /BiRefNet Lite/)
  assert.match(panel.html, /BiRefNet \(Full\)/)
  assert.match(panel.html, /value="birefnet-lite" checked/)
  assert.match(panel.html, /value="birefnet"/)
  assert.match(panel.html, /\$0 provider charge/)
  assert.match(panel.html, /Your original stays in place/)
  assert.doesNotMatch(panel.html, /Gateway|Gemini|Check price|Free/)
  assert.equal(panel.exposed.canStart.value, true)
})

test('queued and failed jobs cannot expose image, download or editor controls even if an output URL is present', async () => {
  for (const status of ['queued', 'running', 'failed', 'cancelled'] as const) {
    const panel = await renderPanel({jobs: [job({status, outputUrl: output})]})
    assert.equal(panel.html.includes(`/api/data${output}`), false)
    assert.doesNotMatch(panel.html, /Download PNG|Use in editor/)
  }
  const panel = await renderPanel({jobs: [job({status: 'succeeded', outputUrl: output, outputAssetId: 'asset'})]})
  assert.equal(panel.html.includes(`src="/api/data${output}?preview=480"`), true)
  assert.equal(panel.html.includes(`href="/api/data${output}"`), true)
  assert.match(panel.html, /Download PNG/)
  assert.match(panel.html, /Use in editor/)
  assert.match(panel.html, /Ready/)
})

test('removed or expired cutouts keep useful history without exposing unavailable media or a Ready status', async () => {
  const panel = await renderPanel({jobs: [job({status: 'succeeded', outputExpired: true, outputUrl: output})]})
  assert.match(panel.html, /Image removed or expired/)
  assert.equal(panel.html.includes(`/api/data${output}`), false)
  assert.doesNotMatch(panel.html, /Download PNG|Use in editor|cutout-status--ready|>Ready</)
})

test('a multi-image action queues independent jobs with the captured exact model and fresh idempotency IDs', async () => {
  const env = environment((url, options) => url === '/api/background-removal' && options.method === 'POST' ? {job: job({id: options.body.sourceUrl, sourceUrl: options.body.sourceUrl, model: options.body.model})} : {jobs: []})
  const panel = await renderPanel({env, sources: [source, secondSource, source], model: 'birefnet'})
  await panel.exposed.start()
  const requests = env.calls.filter(call => call.options.method === 'POST')
  assert.deepEqual(requests.map(call => call.options.body.sourceUrl), [source, secondSource])
  assert.deepEqual(requests.map(call => call.options.body.model), ['birefnet', 'birefnet'])
  assert.notEqual(requests[0]!.options.body.idempotencyKey, requests[1]!.options.body.idempotencyKey)
  for (const request of requests) assert.match(request.options.body.idempotencyKey, /^[0-9a-f-]{36}$/)
  await panel.exposed.start()
  assert.equal(env.calls.filter(call => call.options.method === 'POST').length, 2, 'active jobs cannot be submitted twice')
})

test('an ambiguous request failure retries the same idempotency key and partial batch acceptance does not duplicate jobs', async () => {
  let attempts = 0
  const env = environment((_url, options) => {attempts += 1; if (attempts === 2) throw new Error('network'); return {job: job({id: options.body.sourceUrl, sourceUrl: options.body.sourceUrl})}})
  const panel = await renderPanel({env, sources: [source, secondSource]})
  await panel.exposed.start()
  const acceptedKey = env.calls[0]!.options.body.idempotencyKey
  const ambiguousKey = env.calls[1]!.options.body.idempotencyKey
  assert.match(panel.exposed.errorMessage.value, /Try again/)
  await panel.exposed.start()
  assert.equal(env.calls.length, 3)
  assert.equal(env.calls[2]!.options.body.idempotencyKey, ambiguousKey)
  assert.notEqual(env.calls[2]!.options.body.idempotencyKey, acceptedKey)
})

test('queue overload is bounded and shown without exposing raw server diagnostics', async () => {
  const env = environment(() => {throw {statusCode: 429, statusMessage: 'postgres://private:secret@database'}})
  const panel = await renderPanel({env, sources: [source, secondSource]})
  await panel.exposed.start()
  assert.equal(env.calls.length, 1)
  assert.match(panel.exposed.errorMessage.value, /processing queue is full/)
  assert.doesNotMatch(panel.exposed.errorMessage.value, /private|secret|postgres/)
  const tooMany = await renderPanel({sources: Array.from({length: 6}, (_, index) => source.replace('product.png', `${index}.png`))})
  assert.equal(tooMany.exposed.canStart.value, false)
  assert.match(tooMany.html, /Select up to 5 images/)
})

test('changing the selector during an asynchronous batch cannot change the captured model of sibling jobs', async () => {
  let finishFirst!: (value: unknown) => void
  const env = environment((_url, options) => options.body.sourceUrl === source
    ? new Promise(resolve => {finishFirst = resolve})
    : {job: job({id: 'second', sourceUrl: secondSource, model: options.body.model})})
  const panel = await renderPanel({env, sources: [source, secondSource]})
  const submitting = panel.exposed.start()
  panel.exposed.model.value = 'birefnet'
  finishFirst({job: job()}); await submitting
  assert.deepEqual(env.calls.map(call => call.options.body.model), ['birefnet-lite', 'birefnet-lite'])
})

test('reopening resumes saved jobs, polls their owner endpoint, and announces completion only once', async t => {
  let completed = false
  const env = environment(url => url === '/api/background-removal' ? {jobs: [job(), job({id: 'other-source', sourceUrl: secondSource})]} : {job: job({status: completed ? 'succeeded' : 'running', outputUrl: completed ? output : null})})
  const panel = await mountPanel(env)
  t.after(() => panel.app.unmount())
  assert.deepEqual(panel.exposed.jobs.value.map((item: BackgroundRemovalJob) => item.id), ['job-1'])
  assert.equal(panel.exposed.canStart.value, false)
  await panel.exposed.pollJobs(); completed = true; await panel.exposed.pollJobs(); await nextTick()
  assert.equal(env.calls.filter(call => call.url === '/api/background-removal/job-1').length, 2)
  assert.equal(panel.events.length, 1)
  assert.equal(descendants(panel.tree).some(value => value.tag === 'img' && value.props.src === `/api/data${output}?preview=480`), true)
  await panel.exposed.pollJobs()
  assert.equal(panel.events.length, 1)
})

test('an account switch cancels pending requests and never reveals the previous user’s accepted cutout', async t => {
  let finish!: (value: unknown) => void
  const env = environment((url, options) => options.method === 'POST' ? new Promise(resolve => {finish = resolve}) : {jobs: []})
  const panel = await mountPanel(env)
  t.after(() => panel.app.unmount())
  const submitting = panel.exposed.start()
  const request = env.calls.find(call => call.options.method === 'POST')!
  env.account.identity.value = 'org.bea'; env.account.epoch.value += 1
  assert.equal(request.options.signal.aborted, true)
  finish({job: job({status: 'succeeded', outputUrl: output})}); await submitting; await nextTick()
  assert.deepEqual(panel.exposed.jobs.value, [])
  assert.equal(panel.events.length, 0)
  assert.equal(descendants(panel.tree).some(value => value.tag === 'img' && value.props.src === `/api/data${output}?preview=480`), false)
  assert.equal(descendants(panel.tree).some(value => value.tag === 'img'), false, 'source previews from the previous account also disappear')
  assert.equal(panel.exposed.canStart.value, false)
})

test('job-list failures keep starting disabled until saved progress can be checked', async t => {
  let unavailable = true
  const env = environment(() => {if (unavailable) throw new Error('offline'); return {jobs: []}})
  const panel = await mountPanel(env)
  t.after(() => panel.app.unmount())
  assert.equal(panel.exposed.canStart.value, false)
  assert.equal(descendants(panel.tree).some(value => value.text === 'Retry loading jobs'), true)
  unavailable = false; await panel.exposed.loadJobs()
  assert.equal(panel.exposed.canStart.value, true)
})

test('closing the panel aborts browser requests and cannot display a late success or start another sibling job', async () => {
  let finish!: (value: unknown) => void
  const env = environment((_url, options) => options.method === 'POST' ? new Promise(resolve => {finish = resolve}) : {jobs: []})
  const panel = await mountPanel(env, [source, secondSource])
  const submitting = panel.exposed.start()
  const request = env.calls.find(call => call.options.method === 'POST')!
  panel.app.unmount()
  assert.equal(request.options.signal.aborted, true)
  finish({job: job({status: 'succeeded', outputUrl: output})}); await submitting
  assert.equal(panel.events.length, 0)
  assert.equal(env.calls.filter(call => call.options.method === 'POST').length, 1)
})
