import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { createRenderer, createSSRApp, h, nextTick, reactive, ref } from 'vue'
import { IMAGE_MODEL_PROFILES, createDefaultSettings } from '../schemas/image-generation.ts'
import type { PendingGeneration } from '../app/utils/generationComposer.ts'

const root = new URL('../', import.meta.url)
const formUrl = new URL('app/components/GeminiForm.vue', root).href
const settingsDirectory = new URL('app/components/generation-settings/', root).href
const environmentKey = '__generationWorkspaceUiTest'

// Compile the real editor, its real settings children, and its actual submit
// handler. Only Nuxt services and Nuxt UI primitives are replaced in this test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~~/')) return nextResolve(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === formUrl || (url.startsWith(settingsDirectory) && url.endsWith('.vue'))) {
      const filename = fileURLToPath(url)
      let source = readFileSync(filename, 'utf8')
      if (url === formUrl) source = source.replace('</script>', 'defineExpose({ submit, uploadFiles, loadMoreHistory, sourceImages, data, pickerKind, confirmPicker, previewOutput, previewResult, recentImages, canSubmit, prompt, pendingGenerations, activeGenerationCount, errorMsg, uploading, displayedHistory, historyOpen, confirmedHistory, backgroundRemovalSources, openBackgroundRemoval, useCutout })\n</script>')
      const { descriptor } = parse(source, { filename })
      const compiled = compileScript(descriptor, { id: filename, inlineTemplate: true })
      const nuxtServices = url === formUrl ? `
        const useDataStore = () => globalThis.${environmentKey}.store;
        const useAccount = () => globalThis.${environmentKey}.account;
        const useAccountBalance = () => globalThis.${environmentKey}.accountBalance;
        const useFetch = (...args) => globalThis.${environmentKey}.useFetch(...args);
        const useRoute = () => globalThis.${environmentKey}.route;
        const $fetch = (...args) => globalThis.${environmentKey}.fetch(...args);
        const refreshNuxtData = async () => {};
      ` : ''
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(`import { computed, ref, watch, toRef, toRaw, onMounted, onBeforeUnmount } from 'vue';\n${nuxtServices}\n${compiled.content}`) }
    }
    return nextLoad(url, context)
  },
})

type Store = {
  editSource: string | null
  inputImages: string[]
  models: string[]
  maskImage: string | null
  composerPrompt: string
  pendingGenerations: PendingGeneration[]
  selectedModel: keyof typeof IMAGE_MODEL_PROFILES
  generationSettings: ReturnType<typeof createDefaultSettings>
}

async function renderWorkspace(mode: 'edit' | 'batch', overrides: Partial<Store> = {}) {
  const requests: Array<{ url: string; options: { body?: unknown } }> = []
  const store = reactive<Store>({
    editSource: null, inputImages: [], models: [], maskImage: null, pendingGenerations: [],
    composerPrompt: 'Place on a clean studio background', selectedModel: 'google/gemini-3.1-flash-image',
    generationSettings: createDefaultSettings('google/gemini-3.1-flash-image'), ...overrides,
  })
  const environment: any = {
    store, route: reactive({ query: {} }), exposed: null,
    account: {epoch: ref(1), identity: ref('org.alice')}, refreshes: [], fetchKeys: [], history: ref({ok: true, count: 0, items: []}),
    accountBalance: {balance: ref(null), refresh: async () => {}},
    useFetch(url: string, options: {key?: unknown}) {
      this.fetchKeys.push({url, key: options.key})
      const data = url === '/api/image-models'
        ? { ok: true, items: Object.values(IMAGE_MODEL_PROFILES).map(profile => ({ id: profile.id, profile, available: true, catalogStatus: 'available' })) }
        : { ok: true, count: 0, items: [] }
      return { data: url === '/api/systemprompts' ? this.history : ref(data), status: ref('success'), error: ref(null), refresh: async () => { this.refreshes.push(url) } }
    },
    async fetch(url: string, options: { body?: unknown }) {
      requests.push({ url, options })
      return { ok: true, obj: [{id: 1, status: 'succeeded', outputImage: '/images/output/result.png', errors: null, priceUsd: '0.04500000', priceSource: 'gateway', billingState: 'confirmed'}] }
    },
  }
  ;(globalThis as any)[environmentKey] = environment
  const { default: Form } = await import(formUrl)
  const originalSetup = Form.setup
  const component = { ...Form, setup(props: unknown, context: any) {
    return originalSetup(props, { ...context, expose(value: unknown) { environment.exposed = value; context.expose(value) } })
  } }
  const app = createSSRApp({ render: () => h(component, { mode }) })
  const warnings: string[] = []
  app.config.warnHandler = message => warnings.push(message)
  registerUiPrimitives(app)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [])
  return { html, exposed: environment.exposed, requests, store, environment }
}

function registerUiPrimitives(app: ReturnType<typeof createSSRApp>) {
  app.component('UButton', { props: ['disabled'], setup: (props: any, { slots }: any) => () => h('button', { disabled: props.disabled }, slots.default?.()) })
  app.component('UTextarea', { props: ['modelValue'], setup: (props: any) => () => h('textarea', props.modelValue) })
  app.component('USelect', { props: ['items', 'modelValue'], setup: (props: any) => () => h('select', props.items.map((item: any) => h('option', { value: item.value, selected: item.value === props.modelValue }, item.label))) })
  app.component('UCheckbox', { props: ['label'], setup: (props: any) => () => h('label', [h('input', { type: 'checkbox' }), props.label]) })
  app.component('UBadge', { setup: (_: any, { slots }: any) => () => h('span', slots.default?.()) })
  app.component('UIcon', { render: () => h('span', { 'aria-hidden': 'true' }) })
  app.component('UModal', { render: () => null })
  app.component('AssetBrowser', { render: () => null })
  app.component('BackgroundRemovalPanel', { render: () => null })
  // The parent must not mount result components until their exact prices exist.
  // A marked stub makes that boundary observable independently of the child's
  // defensive visibility gate tested in generated-image-retention-ui.test.ts.
  app.component('system-promp', { props: ['data'], setup: (props: any) => () => h('article', {'data-history-result': props.data.id}, props.data.TextPrompt) })
}

type MemoryNode = { tag: string; text: string; children: MemoryNode[]; parent: MemoryNode | null; props: Record<string, unknown>; [key: string]: any }
function memoryNode(tag: string, text = ''): MemoryNode {
  const node: MemoryNode = { tag, text, children: [], parent: null, props: {}, tagName: tag.toUpperCase(), value: '', selectedIndex: -1,
    addEventListener: () => undefined, removeEventListener: () => undefined, getAttribute: (name: string) => node.props[name] }
  Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.tag === 'option') })
  return node
}
const memoryRenderer = createRenderer<MemoryNode, MemoryNode>({
  createElement: tag => memoryNode(tag), createText: text => memoryNode('#text', text), createComment: text => memoryNode('#comment', text),
  insert(node, parent, anchor) {
    if (node.parent) { const old = node.parent.children.indexOf(node); if (old !== -1) node.parent.children.splice(old, 1) }
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index === -1) parent.children.push(node); else parent.children.splice(index, 0, node)
    node.parent = parent
  },
  remove(node) { if (node.parent) { const index = node.parent.children.indexOf(node); if (index !== -1) node.parent.children.splice(index, 1) }; node.parent = null },
  setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp(node, key, _old, value) { node.props[key] = value; node[key] = value },
})
function descendants(node: MemoryNode): MemoryNode[] { return [node, ...node.children.flatMap(descendants)] }
function historyResultIds(node: MemoryNode): number[] {
  return descendants(node).filter(item => item.tag === 'article' && item.props['data-history-result'] !== undefined)
    .map(item => item.props['data-history-result'] as number)
}
function renderedText(node: MemoryNode): string { return descendants(node).map(item => item.text).join(' ') }

async function mountWorkspace(mode: 'edit' | 'batch', environment: any) {
  ;(globalThis as any)[environmentKey] = environment
  const { default: Form } = await import(formUrl)
  let exposed: any
  const originalSetup = Form.setup
  const component = { ...Form, setup(props: unknown, context: any) {
    return originalSetup(props, { ...context, expose(value: unknown) { exposed = value; context.expose(value) } })
  } }
  const app = memoryRenderer.createApp({ render: () => h(component, { mode }) })
  // The favourites composable needs only a browser event surface on mount.
  ;(globalThis as any).window = { localStorage: { getItem: () => null, setItem: () => undefined }, addEventListener: () => undefined, removeEventListener: () => undefined }
  registerUiPrimitives(app)
  const warnings: string[] = []
  app.config.warnHandler = message => warnings.push(message)
  const rootNode = memoryNode('root')
  app.mount(rootNode)
  await nextTick()
  assert.deepEqual(warnings, [])
  return { app, exposed, rootNode }
}

test('Edit renders a photo-only upload landing while existing batch sources stay selected', async () => {
  const workspace = await renderWorkspace('edit', { inputImages: ['/images/batch-a.png', '/images/batch-b.png'] })
  assert.match(workspace.html, /Start with a product photo/)
  assert.match(workspace.html, /Upload image/)
  assert.doesNotMatch(workspace.html, /studio-composer"/)
  assert.deepEqual(workspace.store.inputImages, ['/images/batch-a.png', '/images/batch-b.png'])
})

test('Edit renders the canvas and submits only the independent Edit source through the existing endpoint', async () => {
  const workspace = await renderWorkspace('edit', { editSource: '/images/edit.png', inputImages: ['/images/batch-a.png', '/images/batch-b.png'], models: ['/images/reference.png'] })
  assert.match(workspace.html, /Image being edited/)
  assert.match(workspace.html, /Model settings/)
  assert.match(workspace.html, /Zoom in/)
  assert.match(workspace.html, /src="\/api\/data\/images\/edit\.png\?preview=1600"/)
  assert.match(workspace.html, /src="\/api\/data\/images\/reference\.png\?preview=160"/)
  assert.equal(workspace.exposed.canSubmit.value, true)
  await workspace.exposed.submit()
  assert.equal(workspace.requests.length, 1)
  assert.equal(workspace.requests[0]!.url, '/api/image-generate')
  const body = workspace.requests[0]!.options.body as any
  assert.deepEqual(body.inputImages, ['/images/edit.png'])
  assert.deepEqual(body.modelImages, ['/images/reference.png'])
  assert.equal(body.settings.kind, 'gemini-3.1-flash-image')
  assert.equal(body.storeInputImages, true)
  assert.equal(workspace.exposed.previewOutput.value, '/images/output/result.png')
  assert.deepEqual(workspace.store.inputImages, ['/images/batch-a.png', '/images/batch-b.png'])
})

test('Same-origin batch renders per-input cards and submits one bounded request without Cartesian combinations', async () => {
  const workspace = await renderWorkspace('batch', { editSource: '/images/edit.png', inputImages: ['/images/batch-a.png', '/images/batch-b.png'], models: ['/images/reference-a.png', '/images/reference-b.png'] })
  assert.match(workspace.html, /Same-origin batch/)
  assert.match(workspace.html, /2 inputs/)
  assert.match(workspace.html, /Input 2: batch-b.png/)
  assert.match(workspace.html, /src="\/api\/data\/images\/batch-a\.png\?preview=480"/)
  assert.match(workspace.html, /src="\/api\/data\/images\/batch-b\.png\?preview=480"/)
  assert.match(workspace.html, /src="\/api\/data\/images\/reference-a\.png\?preview=160"/)
  await workspace.exposed.submit()
  assert.equal(workspace.requests.length, 1)
  const body = workspace.requests[0]!.options.body as any
  assert.deepEqual(body.inputImages, ['/images/batch-a.png', '/images/batch-b.png'])
  assert.deepEqual(body.modelImages, ['/images/reference-a.png', '/images/reference-b.png'])
  assert.equal(body.prompt, workspace.store.composerPrompt)
  assert.equal(workspace.store.editSource, '/images/edit.png')
})

test('the Asset picker replaces only the active workspace selection', async () => {
  const workspace = await renderWorkspace('edit', { editSource: '/images/old.png', inputImages: ['/images/batch-a.png'] })
  workspace.exposed.pickerKind.value = 'source'
  workspace.exposed.confirmPicker([{ name: 'new.png', url: '/images/new.png' }])
  assert.equal(workspace.store.editSource, '/images/new.png')
  assert.deepEqual(workspace.store.inputImages, ['/images/batch-a.png'])
  workspace.exposed.pickerKind.value = 'references'
  workspace.exposed.confirmPicker([{ name: 'light.png', url: '/images/light.png' }])
  assert.deepEqual(workspace.store.models, ['/images/light.png'])
  assert.equal(workspace.store.editSource, '/images/new.png')
})

test('the editor and batch expose local background removal without changing Gateway model settings or originals', async () => {
  const editor = await renderWorkspace('edit', {editSource: '/images/original.png'})
  assert.match(editor.html, /Remove background/)
  const settings = JSON.stringify(editor.store.generationSettings)
  editor.exposed.openBackgroundRemoval(['/images/original.png'])
  assert.deepEqual(editor.exposed.backgroundRemovalSources.value, ['/images/original.png'])
  assert.equal(editor.store.editSource, '/images/original.png')
  assert.equal(JSON.stringify(editor.store.generationSettings), settings)
  await editor.exposed.useCutout('/images/cutout.png')
  assert.equal(editor.store.editSource, '/images/cutout.png')
  assert.deepEqual(editor.exposed.backgroundRemovalSources.value, [])
  assert.equal(editor.requests.length, 0)
  const batch = await renderWorkspace('batch', {inputImages: ['/images/first.png', '/images/second.png']})
  assert.match(batch.html, /Remove backgrounds/)
  batch.exposed.openBackgroundRemoval(batch.exposed.sourceImages.value)
  assert.deepEqual(batch.exposed.backgroundRemovalSources.value, ['/images/first.png', '/images/second.png'])
})

test('the editor withholds generated previews until confirmed billing arrives in account history', async () => {
  const workspace = await renderWorkspace('edit', {editSource: '/images/edit.png'})
  const pending = {id: 7, status: 'succeeded', TextPrompt: 'Waiting for a final cost', outputImage: '/images/output/unconfirmed.png',
    priceUsd: '0.03000000', priceSource: 'estimate', billingState: 'pending'}
  workspace.environment.fetch = async () => ({ok: true, obj: [pending]})
  const previousWindow = (globalThis as any).window
  const mounted = await mountWorkspace('edit', workspace.environment)
  try {
    await mounted.exposed.submit()
    await nextTick()
    assert.equal(mounted.exposed.previewOutput.value, null)
    const imageSources = (node: MemoryNode): unknown[] => [node.props.src, ...node.children.flatMap(imageSources)].filter(Boolean)
    assert.equal(imageSources(mounted.rootNode).some(src => String(src).startsWith(`/api/data${pending.outputImage}`)), false)
    assert.equal(imageSources(mounted.rootNode).includes('/api/data/images/edit.png?preview=1600'), true, 'the original input remains visible through a bounded preview while generated output awaits its final price')
    assert.doesNotMatch(renderedText(mounted.rootNode), /confirming price|Pending confirmation|Result ·|Check prices?/)
    workspace.environment.history.value = {count: 1, items: [pending]}
    await nextTick()
    assert.equal(mounted.exposed.recentImages.value.length, 0)
    assert.equal(mounted.exposed.previewOutput.value, null)
    workspace.environment.history.value = {count: 1, items: [{...pending, priceUsd: '0.00000000', priceSource: 'gateway', billingState: 'confirmed'}]}
    await nextTick()
    assert.equal(mounted.exposed.previewOutput.value, pending.outputImage)
    assert.equal(mounted.exposed.recentImages.value.length, 1)
    assert.equal(imageSources(mounted.rootNode).includes(`/api/data${pending.outputImage}?preview=1600`), true, 'the active editor uses a larger bounded preview')
    workspace.store.editSource = null
    await nextTick()
    assert.equal(imageSources(mounted.rootNode).includes(`/api/data${pending.outputImage}?preview=160`), true, 'recent images on the empty editor landing use small thumbnails')
    workspace.environment.account.identity.value = 'org.bob'
    workspace.environment.account.epoch.value += 1
    workspace.store.editSource = '/images/bob.png'
    workspace.environment.history.value = {count: 0, items: []}
    await nextTick()
    assert.equal(mounted.exposed.previewOutput.value, null)
    assert.equal(mounted.exposed.previewResult.value, null)
  } finally {
    mounted.app.unmount()
    ;(globalThis as any).window = previousWindow
  }
})

test('history mounts only exact-priced result cards and automatically reveals later confirmations without a price-check control', async () => {
  const workspace = await renderWorkspace('edit', {editSource: '/images/edit.png'})
  const rows = [
    {id: 11, status: 'succeeded', TextPrompt: 'Estimated result', outputImage: '/images/output/estimated.png',
      priceUsd: '0.01000000', priceSource: 'estimate', billingState: 'awaiting'},
    {id: 12, status: 'succeeded', TextPrompt: 'Gateway price still pending', outputImage: '/images/output/pending.png',
      priceUsd: '0.01000000', priceSource: 'gateway', billingState: 'awaiting'},
    {id: 13, status: 'succeeded', TextPrompt: 'Confirmed free result', outputImage: '/images/output/free.png',
      priceUsd: '0.000000000000', priceSource: 'gateway', billingState: 'confirmed'},
    {id: 14, status: 'succeeded', TextPrompt: 'Small confirmed charge', outputImage: '/images/output/tiny.png',
      priceUsd: '0.000000000001', priceSource: 'gateway', billingState: 'confirmed'},
    {id: 15, status: 'succeeded', TextPrompt: 'Invalid confirmed price', outputImage: '/images/output/invalid.png',
      priceUsd: '-0.01000000', priceSource: 'gateway', billingState: 'confirmed'},
    {id: 16, status: 'succeeded', TextPrompt: 'Incomplete BYOK price', outputImage: '/images/output/byok.png',
      priceUsd: '0.01000000', priceSource: 'gateway', billingState: 'confirmed', usageJson: {gatewayBilling: {isByok: true}}},
  ]
  workspace.environment.history.value = {ok: true, count: rows.length, items: rows}
  const previousWindow = (globalThis as any).window
  const mounted = await mountWorkspace('edit', workspace.environment)
  try {
    mounted.exposed.historyOpen.value = true
    await nextTick()
    assert.deepEqual(historyResultIds(mounted.rootNode), [13, 14])
    assert.deepEqual(mounted.exposed.recentImages.value.map((row: any) => row.id), [13, 14])
    assert.equal(mounted.exposed.displayedHistory.value.length, rows.length, 'unpriced metadata must remain available for automatic reconciliation and raw pagination')
    assert.doesNotMatch(renderedText(mounted.rootNode), /Check prices?|Estimated result|Gateway price still pending|Invalid confirmed price|Incomplete BYOK price/)
    workspace.environment.history.value = {ok: true, count: rows.length, items: rows.map(row => row.id === 11
      ? {...row, priceUsd: '0.034000000001', priceSource: 'gateway', billingState: 'confirmed'} : row)}
    await nextTick()
    assert.deepEqual(historyResultIds(mounted.rootNode), [11, 13, 14])
    assert.deepEqual(mounted.exposed.recentImages.value.map((row: any) => row.id), [11, 13, 14])
    assert.doesNotMatch(renderedText(mounted.rootNode), /Check prices?|confirming price/)
    assert.deepEqual(workspace.requests, [], 'history prop updates must not trigger a manual billing or generation request')
  } finally {
    mounted.app.unmount()
    ;(globalThis as any).window = previousWindow
  }
})

test('price polling is bounded and finite-credit accounts wait for outstanding prices to settle', async () => {
  const workspace = await renderWorkspace('edit', {editSource: '/images/edit.png'})
  workspace.environment.history.value = {count: 1, items: [{id: 9, status: 'succeeded', outputImage: null, priceUsd: null, priceSource: null, billingState: 'pending'}]}
  workspace.environment.accountBalance.balance.value = {unlimited: false, actualBalanceUsd: '2.000000000000', outstandingCount: 1}
  const timers: Array<() => Promise<void>> = []
  const originalTimeout = globalThis.setTimeout
  const originalDocument = (globalThis as any).document
  const previousWindow = (globalThis as any).window
  ;(globalThis as any).setTimeout = (fn: () => Promise<void>, delay: number, ...args: any[]) => delay === 10_000 ? (timers.push(fn), timers.length) : originalTimeout(fn, delay, ...args)
  ;(globalThis as any).document = {visibilityState: 'visible'}
  let mounted: Awaited<ReturnType<typeof mountWorkspace>> | undefined
  try {
    mounted = await mountWorkspace('edit', workspace.environment)
    assert.equal(mounted.exposed.canSubmit.value, false)
    for (let attempt = 0; attempt < 30; attempt++) { const next = timers.shift(); assert.ok(next); await next() }
    assert.equal(timers.length, 0)
    assert.equal(workspace.environment.refreshes.filter((url: string) => url === '/api/systemprompts').length, 30)
    workspace.environment.accountBalance.balance.value = {unlimited: false, actualBalanceUsd: '2.000000000000', outstandingCount: 0}
    await nextTick()
    assert.equal(mounted.exposed.canSubmit.value, true)
    workspace.environment.accountBalance.balance.value = {unlimited: false, actualBalanceUsd: '2.000000000000', outstandingCount: 1, generationBlockedByOutstanding: false}
    await nextTick()
    assert.equal(mounted.exposed.canSubmit.value, true, 'historical unpriced entries without a retryable charge do not block new finite-credit generations')
    workspace.environment.accountBalance.balance.value = {unlimited: false, actualBalanceUsd: '-0.005000000001', outstandingCount: 0}
    await nextTick()
    assert.equal(mounted.exposed.canSubmit.value, false)
    workspace.environment.accountBalance.balance.value = {unlimited: true, actualBalanceUsd: null, outstandingCount: 1}
    await nextTick()
    assert.equal(mounted.exposed.canSubmit.value, true)
  } finally {
    mounted?.app.unmount()
    globalThis.setTimeout = originalTimeout
    ;(globalThis as any).document = originalDocument
    ;(globalThis as any).window = previousWindow
  }
})

test('navigation unmounts and remounts the editor without losing an in-flight request or permitting a duplicate', async () => {
  const workspace = await renderWorkspace('edit', { editSource: '/images/edit.png', inputImages: ['/images/batch-a.png', '/images/batch-b.png'] })
  let resolveProvider!: (value: unknown) => void
  const provider = new Promise(resolve => { resolveProvider = resolve })
  workspace.environment.fetch = async (url: string, options: { body?: unknown }) => {
    workspace.requests.push({ url, options })
    return provider
  }
  const previousWindow = (globalThis as any).window
  let first: Awaited<ReturnType<typeof mountWorkspace>> | undefined
  let remounted: Awaited<ReturnType<typeof mountWorkspace>> | undefined
  let request: Promise<void> | undefined
  try {
    first = await mountWorkspace('edit', workspace.environment)
    request = first.exposed.submit()
    await nextTick()
    assert.equal(workspace.requests.length, 1)
    assert.equal(first.exposed.activeGenerationCount.value, 1)
    first.app.unmount()
    first = undefined
    await nextTick()
    // Assets has no composer. Opening Batch next creates a new component.
    assert.equal(workspace.store.pendingGenerations.length, 1)
    remounted = await mountWorkspace('batch', workspace.environment)
    assert.equal(remounted.exposed.activeGenerationCount.value, 1)
    assert.equal(remounted.exposed.canSubmit.value, false)
    const text = (node: MemoryNode): string => node.text + node.children.map(text).join(' ')
    assert.match(text(remounted.rootNode), /1 input jobs running/)
    await remounted.exposed.submit()
    assert.equal(workspace.requests.length, 1, 'returning to either workspace must not start another paid call')

    resolveProvider({ ok: true, obj: [{ outputImage: '/images/output/result.png', errors: null }] })
    await request
    await nextTick()
    assert.equal(remounted.exposed.activeGenerationCount.value, 0)
    assert.equal(workspace.store.pendingGenerations.length, 0)
    assert.equal(remounted.exposed.canSubmit.value, true)
    assert.equal(workspace.requests.length, 1)
    assert.deepEqual(workspace.store.inputImages, ['/images/batch-a.png', '/images/batch-b.png'])
  } finally {
    resolveProvider({ ok: true, obj: [] })
    await request
    first?.app.unmount()
    remounted?.app.unmount()
    ;(globalThis as any).window = previousWindow
  }
})

test('uploads select the server-assigned immutable image URL instead of rebuilding it from a filename', async () => {
  const workspace = await renderWorkspace('edit')
  const url = '/images/organizations/11111111-1111-4111-8111-111111111111/users/22222222-2222-4222-8222-222222222222/objects/33333333-3333-4333-8333-333333333333/product.png'
  workspace.environment.fetch = async () => ({saved: ['product.png'], savedFiles: [{name: 'product.png', url}], failed: []})
  await workspace.exposed.uploadFiles([new File(['test'], 'product.png', {type: 'image/png'})])
  assert.equal(workspace.store.editSource, url)
  assert.equal(workspace.exposed.errorMsg.value, null)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`a generation ${outcome} arriving after an account switch cannot change the next user's workspace`, async () => {
    const workspace = await renderWorkspace('edit', {editSource: '/images/alice.png'})
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    workspace.environment.fetch = () => new Promise((yes, no) => { resolve = yes; reject = no })
    const previousWindow = (globalThis as any).window
    const mounted = await mountWorkspace('edit', workspace.environment)
    const request = mounted.exposed.submit()
    try {
      assert.equal(workspace.store.pendingGenerations.length, 1)
      workspace.environment.account.epoch.value += 1
      workspace.environment.account.identity.value = 'org.bob'
      workspace.store.editSource = '/images/bob.png'
      workspace.store.composerPrompt = 'Bob private prompt'
      const bobJob: PendingGeneration = {id: 'bob-active', prompt: 'Bob private prompt', model: workspace.store.selectedModel,
        inputImages: ['/images/bob.png'], modelImages: [], startedAt: Date.now(), status: 'pending'}
      workspace.store.pendingGenerations = [bobJob]
      await nextTick()
      if (outcome === 'success') resolve({ok: true, obj: [{outputImage: '/images/output/alice.png', errors: 'Alice private error'}]})
      else reject({data: {statusMessage: 'Alice private failure'}})
      await request
      assert.equal(workspace.store.editSource, '/images/bob.png')
      assert.equal(workspace.store.composerPrompt, 'Bob private prompt')
      assert.deepEqual(workspace.store.pendingGenerations, [bobJob])
      assert.equal(mounted.exposed.previewOutput.value, null)
      assert.equal(mounted.exposed.errorMsg.value, null)
      assert.deepEqual(workspace.environment.refreshes, [], 'a stale request must not refresh a new account history')
      const privateKeys = workspace.environment.fetchKeys.filter((entry: any) => entry.url !== '/api/image-models')
      assert.ok(privateKeys.every((entry: any) => entry.key.value.endsWith(':org.bob:2')))
    } finally {
      resolve({ok: true, obj: []})
      await request
      mounted.app.unmount()
      ;(globalThis as any).window = previousWindow
    }
  })
}

test('late upload and paginated history results are discarded after an account switch', async () => {
  const workspace = await renderWorkspace('edit', {editSource: '/images/alice.png'})
  const originalUseFetch = workspace.environment.useFetch
  workspace.environment.useFetch = function(url: string, options: any) {
    const result = originalUseFetch.call(this, url, options)
    if (url === '/api/systemprompts') result.data.value = {count: 2, items: [{id: 1, TextPrompt: 'Alice previous', outputImage: null}]}
    return result
  }
  const responses: Array<(value: unknown) => void> = []
  workspace.environment.fetch = () => new Promise(resolve => { responses.push(resolve) })
  const previousWindow = (globalThis as any).window
  const mounted = await mountWorkspace('edit', workspace.environment)
  const upload = mounted.exposed.uploadFiles([new File(['test'], 'product.png', {type: 'image/png'})])
  const history = mounted.exposed.loadMoreHistory()
  try {
    assert.equal(responses.length, 2)
    workspace.environment.account.epoch.value += 1
    workspace.environment.account.identity.value = 'org.bob'
    workspace.store.editSource = '/images/bob.png'
    responses[0]!({savedFiles: [{url: '/images/alice-new.png'}], failed: [{filename: 'private.png', reason: 'Alice error'}]})
    responses[1]!({count: 2, items: [{id: 2, TextPrompt: 'Alice private history', outputImage: '/images/alice-output.png'}]})
    await Promise.all([upload, history])
    assert.equal(workspace.store.editSource, '/images/bob.png')
    assert.equal(mounted.exposed.errorMsg.value, null)
    assert.equal(mounted.exposed.uploading.value, false)
    assert.equal(mounted.exposed.displayedHistory.value.some((item: any) => item.id === 2), false)
  } finally {
    responses.forEach(resolve => resolve({savedFiles: [], failed: [], count: 0, items: []}))
    await Promise.all([upload, history])
    mounted.app.unmount()
    ;(globalThis as any).window = previousWindow
  }
})
