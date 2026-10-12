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
      if (url === formUrl) source = source.replace('</script>', 'defineExpose({ submit, uploadFiles, loadMoreHistory, sourceImages, data, pickerKind, confirmPicker, previewOutput, canSubmit, prompt, pendingGenerations, activeGenerationCount, errorMsg, uploading, displayedHistory })\n</script>')
      const { descriptor } = parse(source, { filename })
      const compiled = compileScript(descriptor, { id: filename, inlineTemplate: true })
      const nuxtServices = url === formUrl ? `
        const useDataStore = () => globalThis.${environmentKey}.store;
        const useAccount = () => globalThis.${environmentKey}.account;
        const useFetch = (...args) => globalThis.${environmentKey}.useFetch(...args);
        const useRoute = () => globalThis.${environmentKey}.route;
        const $fetch = (...args) => globalThis.${environmentKey}.fetch(...args);
        const refreshNuxtData = async () => {};
      ` : ''
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(`import { computed, ref, watch, toRef, toRaw, onBeforeUnmount } from 'vue';\n${nuxtServices}\n${compiled.content}`) }
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
    account: {epoch: ref(1), identity: ref('org.alice')}, refreshes: [], fetchKeys: [],
    useFetch(url: string, options: {key?: unknown}) {
      this.fetchKeys.push({url, key: options.key})
      const data = url === '/api/image-models'
        ? { ok: true, items: Object.values(IMAGE_MODEL_PROFILES).map(profile => ({ id: profile.id, profile, available: true, catalogStatus: 'available' })) }
        : { ok: true, count: 0, items: [] }
      return { data: ref(data), status: ref('success'), error: ref(null), refresh: async () => { this.refreshes.push(url) } }
    },
    async fetch(url: string, options: { body?: unknown }) {
      requests.push({ url, options })
      return { ok: true, obj: [{ outputImage: '/images/output/result.png', errors: null }] }
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
  app.component('system-promp', { render: () => h('article') })
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
