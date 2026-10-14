import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {computed, createRenderer, createSSRApp, h, nextTick, reactive, ref} from 'vue'
import {IMAGE_MODEL_PROFILES, ImageGenerationRequestSchema, SUPPORTED_IMAGE_MODEL_IDS, createDefaultSettings, type ImageModelId} from '../schemas/image-generation.ts'
import {CATALOG_IMAGE_DEFINITIONS, CATALOG_IMAGE_MODEL_IDS} from '../schemas/catalog-image-models.ts'
import {BACKGROUND_REMOVAL_MODELS} from '../schemas/background-removal-models.ts'
import {isNewImageModel, orderImageModels} from '../schemas/image-model-discovery.ts'
import {createPipelineNode, type PipelineNode} from '../schemas/pipelines.ts'

const transparentIds: readonly ImageModelId[] = ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare', 'openai/gpt-image-1.5', 'openai/gpt-image-1', 'openai/gpt-image-1-mini']
const transparentSet = new Set(transparentIds)

test('transparency is required explicit capability metadata for every exact model ID', () => {
  assert.deepEqual(SUPPORTED_IMAGE_MODEL_IDS.filter(id => IMAGE_MODEL_PROFILES[id].supportsTransparentBackground).sort(), [...transparentIds].sort())
  for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[id]
    assert.equal(Object.hasOwn(profile, 'supportsTransparentBackground'), true, `${id}: model additions must declare transparency support`)
    assert.equal(typeof profile.supportsTransparentBackground, 'boolean', id)
    assert.equal(profile.supportsTransparentBackground, transparentSet.has(id), id)
  }
  for (const id of CATALOG_IMAGE_MODEL_IDS) {
    const definition = CATALOG_IMAGE_DEFINITIONS[id]
    assert.equal(Object.hasOwn(definition, 'supportsTransparentBackground'), true, `${id}: catalog additions must choose their own capability`)
    assert.equal(typeof definition.supportsTransparentBackground, 'boolean', id)
    assert.equal(IMAGE_MODEL_PROFILES[id].supportsTransparentBackground, definition.supportsTransparentBackground, id)
  }
  assert.deepEqual(BACKGROUND_REMOVAL_MODELS.map(model => [model.id, model.supportsTransparentBackground]), [['birefnet-lite', true], ['birefnet', true]])
})

test('a Transparent tag agrees with validated alpha-capable settings rather than a PNG extension', () => {
  for (const model of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[model]
    const request = {model, prompt: 'Keep the product with a transparent background', inputImages: ['/images/product.png'], ...(profile.requiresMask ? {maskImage: '/images/mask.png'} : {})}
    for (const outputFormat of ['png', 'webp', 'jpeg']) {
      const parsed = ImageGenerationRequestSchema.safeParse({...request, settings: {...createDefaultSettings(model), background: 'transparent', outputFormat}})
      assert.equal(parsed.success, profile.supportsTransparentBackground && outputFormat !== 'jpeg', `${model}: transparent ${outputFormat}`)
      if (parsed.success) {
        assert.equal('background' in parsed.data.settings && parsed.data.settings.background, 'transparent')
        assert.equal('outputFormat' in parsed.data.settings && parsed.data.settings.outputFormat, outputFormat)
      }
    }
  }
})

const root = new URL('../', import.meta.url)
const key = '__modelTransparencyUi'
const urls = {
  form: new URL('app/components/GeminiForm.vue', root).href,
  person: new URL('app/components/PersonGenerator.vue', root).href,
  pipeline: new URL('app/components/PipelineNodeProperties.vue', root).href,
  removal: new URL('app/components/BackgroundRemovalPanel.vue', root).href,
}
const favouriteUrl = new URL('app/composables/useImageModelFavourites.ts', root).href
const settingsDirectory = new URL('app/components/generation-settings/', root).href
const exposures: Record<string, string> = {
  [urls.form]: 'data,modelOptions,selectedModelValue,selectedProfile',
  [urls.person]: 'model,settings,models,profile,orderedModels',
  [urls.pipeline]: 'changeModel,imageProfile,orderedModels',
  [urls.removal]: 'model,historyReady',
}

// Render app-owned selectors and settings as real Vue components. Nuxt service
// stubs use only in-memory fixtures; a generation call fails this test.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('~~/')) return next(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === favouriteUrl) return {format: 'module', shortCircuit: true, source: `export const useImageModelFavourites=()=>globalThis.${key}.favourites;`}
    if ((exposures[url] || url.startsWith(settingsDirectory)) && url.endsWith('.vue')) {
      const filename = fileURLToPath(url)
      let source = readFileSync(filename, 'utf8')
      if (exposures[url]) source = source.replace('</script>', `defineExpose({${exposures[url]}})\n</script>`)
      const {descriptor} = parse(source, {filename})
      const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true, templateOptions: {compilerOptions: {hoistStatic: false}}})
      return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`
        import {computed,ref,watch,toRef,toRaw,onMounted,onBeforeUnmount,onServerPrefetch,nextTick} from 'vue';
        const useDataStore=()=>globalThis.${key}.store;
        const useAccount=()=>globalThis.${key}.account;
        const useAccountBalance=()=>globalThis.${key}.balance;
        const useGenerationCredit=()=>({checking:ref(false),outstandingBlocked:ref(false),open:ref(false)});
        const usePeopleGenerationProgress=()=>({running:()=>false});
        const useRequestFetch=()=>globalThis.${key}.fetch;
        const useFetch=(...args)=>globalThis.${key}.useFetch(...args);
        const useRoute=()=>({query:{}});
        const $fetch=(...args)=>globalThis.${key}.fetch(...args);
        const refreshNuxtData=async()=>{};
        ${compiled.content}`)}
    }
    return next(url, context)
  },
})

type Surface = keyof typeof urls
function environment(model: ImageModelId) {
  const ids = ref<ImageModelId[]>([])
  const models = SUPPORTED_IMAGE_MODEL_IDS.map(id => ({id, profile: IMAGE_MODEL_PROFILES[id], catalogStatus: 'available'}))
  const store = reactive({editSource: '/images/product.png', inputImages: ['/images/product.png'], models: [], maskImage: null, composerPrompt: 'A product picture', pendingGenerations: [], selectedModel: model, generationSettings: createDefaultSettings(model)})
  const pipelineNode = createPipelineNode('generate-image', 'generation')
  assert.equal(pipelineNode.type, 'generate-image')
  pipelineNode.config.model = model
  pipelineNode.config.settings = createDefaultSettings(model)
  const pipeline = reactive<{node: PipelineNode}>({node: pipelineNode})
  return {
    store, models, pipeline,
    account: {epoch: ref(1), identity: ref('org.alice')},
    balance: {balance: ref({unlimited: true, actualBalanceUsd: null, outstandingCount: 0}), refresh: async () => {}},
    favourites: {favouriteModelIds: ids, favouriteSet: computed(() => new Set(ids.value)), ready: ref(true), persistent: ref(true), toggleFavourite(id: ImageModelId) {ids.value = ids.value.includes(id) ? ids.value.filter(value => value !== id) : [...ids.value, id]}},
    useFetch(url: string) {return {data: ref(url === '/api/image-models' ? {ok: true, items: models} : {ok: true, items: [], count: 0}), status: ref('success'), error: ref(null), refresh: async () => {}}},
    fetch: async (url: string, options: {method?: string} = {}) => {
      assert.equal(options.method === 'POST', false, 'selector tests must never start paid work')
      if (url === '/api/image-models') return {items: models}
      if (url === '/api/background-removal') return {jobs: []}
      return {items: []}
    },
  }
}
function props(surface: Surface, env: ReturnType<typeof environment>) {
  if (surface === 'form') return {mode: 'edit'}
  if (surface === 'removal') return {sourceUrls: ['/images/product.png']}
  if (surface === 'person') return {person: {id: '11111111-1111-4111-8111-111111111111', name: 'Alex', description: 'An adult'}, photos: []}
  return {node: env.pipeline.node, definition: {version: 1, nodes: [env.pipeline.node], edges: []}, models: env.models, onUpdate: (node: PipelineNode) => {env.pipeline.node = node}}
}
function primitives(app: ReturnType<typeof createSSRApp>) {
  app.component('ModelGuidance', {render: () => null})
  app.component('UIcon', {render: () => h('span', {'aria-hidden': true})})
  app.component('UButton', {props: ['disabled'], setup: (props: any, {slots}: any) => () => h('button', {disabled: props.disabled}, slots.default?.())})
  app.component('UBadge', {setup: (_: unknown, {slots}: any) => () => h('span', slots.default?.())})
  app.component('UTextarea', {props: ['modelValue'], setup: (props: any) => () => h('textarea', props.modelValue)})
  app.component('UCheckbox', {props: ['label'], setup: (props: any) => () => h('label', [h('input', {type: 'checkbox'}), props.label])})
  app.component('USelect', {props: ['items'], setup: (props: any, {slots}: any) => () => h('div', {'data-model-options': true}, props.items.map((item: any) => h('div', {'data-model-id': item.value}, [item.label, slots['item-trailing']?.({item})])))})
  app.component('NuxtErrorBoundary', {setup: (_: unknown, {slots}: any) => () => slots.default?.()})
  for (const name of ['UModal', 'AssetBrowser', 'PeopleBrowser', 'BackgroundRemovalPanel', 'system-promp']) app.component(name, {render: () => null})
}
async function component(surface: Surface, env: ReturnType<typeof environment>) {
  ;(globalThis as any)[key] = env
  const {default: Component} = await import(urls[surface])
  let exposed: any
  const original = Component.setup
  return {getExposed: () => exposed, value: {...Component, setup(value: unknown, context: any) {
    return original(value, {...context, expose(value: any) {
      exposed = value
      if (surface === 'person') {value.model.value = env.store.selectedModel; value.models.value = env.models}
      if (surface === 'removal') value.historyReady.value = true
      context.expose(value)
    }})
  }}}
}
async function render(surface: Surface, model: ImageModelId = 'google/gemini-3.1-flash-image') {
  const env = environment(model), target = await component(surface, env)
  const app = createSSRApp({render: () => h(target.value, props(surface, env))})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  primitives(app)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [])
  return {html, env, exposed: target.getExposed()}
}

test('generation, People and pipeline selectors tag only verified transparent models while preserving New labels', async () => {
  for (const surface of ['form', 'person', 'pipeline'] as const) {
    const {html, exposed} = await render(surface)
    const options = surface === 'form' ? exposed.modelOptions.value : exposed.orderedModels.value
    assert.deepEqual(options.map((item: any) => item.value ?? item.id), orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, []))
    for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
      const option = surface === 'form'
        ? html.match(new RegExp(`<div data-model-id="${id.replaceAll('.', '\\.')}"[\\s\\S]*?(?=<div data-model-id=|</div></div>)`))?.[0]
        : html.match(new RegExp(`<option[^>]*value="${id.replaceAll('.', '\\.')}"[^>]*>([\\s\\S]*?)</option>`))?.[1]
      assert.ok(option, `${surface}: ${id} must appear in the actual rendered selector`)
      assert.equal(option.includes('Transparent'), transparentSet.has(id), `${surface}: ${id} transparency label`)
      assert.equal(/>New<| · New/.test(option), isNewImageModel(id), `${surface}: ${id} New label remains independent`)
    }
    assert.equal((html.match(/class="[^"]*model-transparent-badge/g) ?? []).length, transparentIds.length * (surface === 'form' ? 1 : 0), `${surface}: no selected transparency badge on a non-transparent model`)
  }
})

test('selected-model summaries explain transparency only for capable models, without enabling it automatically', async () => {
  for (const surface of ['form', 'person', 'pipeline'] as const) {
    for (const model of ['openai/gpt-image-1.5', 'openai/gpt-image-2'] as const) {
      const {html, env, exposed} = await render(surface, model)
      const hasSupport = transparentSet.has(model)
      assert.equal(html.includes('choose Background → Transparent'), hasSupport, `${surface}: selected ${model} helper`)
      assert.equal((html.match(/class="[^"]*model-transparent-badge/g) ?? []).length, (surface === 'form' ? transparentIds.length : 0) + Number(hasSupport), `${surface}: selected ${model} badge`)
      const settings = surface === 'form' ? env.store.generationSettings : surface === 'person' ? exposed.settings.value : (env.pipeline.node.config as any).settings
      assert.deepEqual(settings, createDefaultSettings(model), `${surface}: tagging a model must not alter requested settings`)
    }
  }
})

test('dedicated background-removal options and pipeline removal models are visibly marked Transparent', async () => {
  const removal = await render('removal')
  assert.equal((removal.html.match(/class="[^"]*model-transparent-badge/g) ?? []).length, 2)
  for (const label of ['BiRefNet Lite', 'BiRefNet (Full)']) assert.ok(removal.html.includes(label))
  const env = environment('google/gemini-3.1-flash-image')
  env.pipeline.node = createPipelineNode('remove-background', 'remove')
  const target = await component('pipeline', env)
  const app = createSSRApp({render: () => h(target.value, props('pipeline', env))}); primitives(app)
  const html = await renderToString(app)
  for (const id of ['birefnet-lite', 'birefnet']) assert.match(html, new RegExp(`<option[^>]*value="${id}"[^>]*>[\\s\\S]*?Transparent[\\s\\S]*?</option>`))
})

type MemoryNode = {tag: string; text: string; children: MemoryNode[]; parent: MemoryNode | null; props: Record<string, any>; [key: string]: any}
function node(tag: string, text = ''): MemoryNode {
  const value: MemoryNode = {tag, text, children: [], parent: null, props: {}, tagName: tag.toUpperCase(), value: '', selectedIndex: -1, addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, getAttribute: name => value.props[name]}
  Object.defineProperty(value, 'options', {get: () => value.children.filter(child => child.tag === 'option')})
  return value
}
const renderer = createRenderer<MemoryNode, MemoryNode>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(value, parent, anchor) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(value); else parent.children.splice(index, 0, value); value.parent = parent},
  remove(value) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); value.parent = null},
  setText(value, text) {value.text = text}, setElementText(value, text) {value.text = text; value.children = []},
  parentNode: value => value.parent, nextSibling: value => value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null,
  patchProp(value, name, _previous, next) {value.props[name] = next; value[name] = next},
})
function descendants(value: MemoryNode): MemoryNode[] {return [value, ...value.children.flatMap(descendants)]}
function badgeCount(value: MemoryNode) {return descendants(value).filter(node => String(node.props.class ?? '').split(' ').includes('model-transparent-badge')).length}

test('changing the selected model updates its badge and favourites preserve that selection and its settings', async t => {
  ;(globalThis as any).HTMLElement = class {}
  ;(globalThis as any).document = {activeElement: null, visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}}
  ;(globalThis as any).window = {addEventListener: () => {}, removeEventListener: () => {}}
  for (const surface of ['form', 'person', 'pipeline'] as const) {
    const env = environment('openai/gpt-image-1.5'), target = await component(surface, env)
    const app = renderer.createApp({render: () => h(target.value, props(surface, env))}); primitives(app)
    const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
    const tree = node('root'); app.mount(tree); t.after(() => app.unmount()); await nextTick(); await nextTick()
    const exposed = target.getExposed(), selectorBadges = surface === 'form' ? transparentIds.length : 0
    assert.equal(badgeCount(tree), selectorBadges + 1, surface)
    function select(model: ImageModelId) {
      if (surface === 'form') exposed.selectedModelValue.value = model
      else if (surface === 'person') exposed.model.value = model
      else exposed.changeModel({target: {value: model}})
    }
    function state() {
      if (surface === 'form') return {model: env.store.selectedModel, settings: env.store.generationSettings}
      if (surface === 'person') return {model: exposed.model.value, settings: exposed.settings.value}
      return {model: (env.pipeline.node.config as any).model, settings: (env.pipeline.node.config as any).settings}
    }
    select('openai/gpt-image-2'); await nextTick()
    assert.equal(badgeCount(tree), selectorBadges, `${surface}: negative model cannot retain the previous badge`)
    select('openai/gpt-image-2.5-flare'); await nextTick()
    assert.equal(badgeCount(tree), selectorBadges + 1, `${surface}: capable model restores the badge`)
    const before = JSON.parse(JSON.stringify(state()))
    env.favourites.toggleFavourite('openai/gpt-image-2.5-flare'); await nextTick()
    assert.deepEqual(state(), before, `${surface}: favouriting must not change model/settings`)
    const ordered = surface === 'form' ? exposed.modelOptions.value : exposed.orderedModels.value
    assert.equal(ordered[0].value ?? ordered[0].id, 'openai/gpt-image-2.5-flare')
    assert.equal(badgeCount(tree), selectorBadges + 1)
    assert.deepEqual(warnings, [], surface)
    app.unmount()
  }
})
