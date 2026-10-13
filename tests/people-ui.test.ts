import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {computed, createRenderer, createSSRApp, h, nextTick, ref} from 'vue'
import {IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, createDefaultSettings, type ImageModelId} from '../schemas/image-generation.ts'
import type {Person, PersonPhoto} from '../schemas/people.ts'

const root = new URL('../', import.meta.url)
const browserUrl = new URL('app/components/PeopleBrowser.vue', root).href
const generatorUrl = new URL('app/components/PersonGenerator.vue', root).href
const progressUrl = new URL('app/composables/usePeopleGenerationProgress.ts', root).href
const favouritesUrl = new URL('app/composables/useImageModelFavourites.ts', root).href
const key = '__peopleUiTest'
const exposures: Record<string, string> = {
  [browserUrl]: 'people, activePerson, photos, pendingCount, failedCount, photoCursor, selection, loading, loadingMore, detailLoading, saving, removing, attaching, detailError, errorMessage, newName, newDescription, editName, editDescription, search, keyword, createOpen, selectionNotice, openPerson, back, loadPeople, loadPerson, pollDetail, togglePhoto, confirm, createPerson, savePerson, removePhoto, generated, generatorClosed, visibilityChanged, pollingPaused',
  [generatorUrl]: 'model, settings, models, referenceUrls, selectedReferences, scene, pictureCount, totalPictures, canGenerate, generate, generating, running, errorMessage, toggleReference, generationPrompt, loadModels',
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~~/')) return nextResolve(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === favouritesUrl) return {format: 'module', shortCircuit: true, source: `export const useImageModelFavourites = () => globalThis.${key}.favourites;`}
    if (url === progressUrl) return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed, watch} from 'vue'; const useAccount = () => globalThis.${key}.account; const useState = (name, initial) => globalThis.${key}.state(name, initial); ${readFileSync(fileURLToPath(url), 'utf8')}`)}
    if ((url === browserUrl || url === generatorUrl || url.startsWith(new URL('app/components/generation-settings/', root).href)) && url.endsWith('.vue')) {
      const filename = fileURLToPath(url)
      let source = readFileSync(filename, 'utf8')
      if (exposures[url]) source = source.replace('</script>', `defineExpose({${exposures[url]}})\n</script>`)
      const {descriptor} = parse(source, {filename})
      const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
      return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed, ref, watch, onMounted, onBeforeUnmount, onServerPrefetch, nextTick, toRaw} from 'vue';
        import {usePeopleGenerationProgress} from '${progressUrl}';
        const useAccount = () => globalThis.${key}.account;
        const useRequestFetch = () => (...args) => globalThis.${key}.fetch(...args);
        const useAccountBalance = () => globalThis.${key}.balance;
        ${compiled.content}`)}
    }
    return nextLoad(url, context)
  },
})

const source = '/images/organizations/org/users/alice/objects/portrait/person.png'
const otherSource = '/images/organizations/org/users/alice/objects/product/product.png'
function photo(overrides: Partial<PersonPhoto> = {}): PersonPhoto { return {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', url: source, name: 'Portrait.png', priceUsd: '0.035', priceSource: 'gateway', generationId: 42, ...overrides} }
function person(overrides: Partial<Person> = {}): Person { return {id: '11111111-1111-4111-8111-111111111111', name: 'Alex', description: 'An adult with short auburn hair, freckles, and relaxed style.', photoCount: 1, cover: photo(), createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...overrides} }
function detail(pictures = [photo()], overrides: Record<string, unknown> = {}) { return {person: person({photoCount: pictures.length}), photos: pictures, pendingCount: 0, failedCount: 0, nextCursor: null, ...overrides} }
function environment(fetch?: (url: string, options: any) => unknown) {
  const calls: Array<{url: string; options: any}> = []
  const states = new Map<string, ReturnType<typeof ref>>()
  const favouriteIds = ref<ImageModelId[]>([])
  const account = {epoch: ref(1), identity: ref('org.alice')}
  const models = SUPPORTED_IMAGE_MODEL_IDS.map(id => ({id, catalogStatus: 'available'}))
  return {account, calls, models, states,
    state(name: string, initial: () => unknown) { if (!states.has(name)) states.set(name, ref(initial())); return states.get(name)! },
    favourites: {favouriteModelIds: favouriteIds, favouriteSet: computed(() => new Set(favouriteIds.value)), persistent: ref(true), ready: ref(true), toggleFavourite(id: ImageModelId) { favouriteIds.value = favouriteIds.value.includes(id) ? favouriteIds.value.filter(value => value !== id) : [...favouriteIds.value, id] }},
    balance: {balance: ref({unlimited: true, actualBalanceUsd: null, outstandingCount: 0}), pending: ref(false), error: ref(''), refresh: async () => {}},
    fetch: async (url: string, options: any = {}) => { calls.push({url, options}); if (fetch) return fetch(url, options); if (url === '/api/image-models') return {items: models}; if (url === '/api/people') return {people: [person()], nextCursor: null}; return detail() },
  }
}
function registerComponents(app: any) {
  app.component('UIcon', {render: () => h('span', {'aria-hidden': 'true'})})
  app.component('UCheckbox', {render: () => h('input', {type: 'checkbox'})})
  app.component('NuxtErrorBoundary', {render(this: any) { return this.$slots.default?.() }})
  app.component('AssetBrowser', {render: () => h('div')})
  app.component('PersonGenerator', {render: () => h('div')})
}
async function renderComponent(url: string, options: {env?: ReturnType<typeof environment>; props?: Record<string, unknown>; initialize?: (value: any) => void} = {}) {
  const env = options.env ?? environment(); (globalThis as any)[key] = env
  const {default: Component} = await import(url)
  let exposed: any
  const originalSetup = Component.setup
  const component = {...Component, setup(props: unknown, context: any) { return originalSetup(props, {...context, expose(value: any) { exposed = value; options.initialize?.(value); context.expose(value) }}) }}
  const events: Array<{name: string; value: unknown}> = []
  const props = url === generatorUrl ? {person: person(), photos: [photo()], ...options.props} : options.props
  const app = createSSRApp({render: () => h(component, {...props, onConfirm: (value: unknown) => events.push({name: 'confirm', value}), 'onUpdate:selectedUrls': (value: unknown) => events.push({name: 'selection', value}), onGenerated: () => events.push({name: 'generated', value: null})})})
  registerComponents(app)
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app); assert.deepEqual(warnings, [])
  return {env, exposed, html, events}
}
type Node = {tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, any>; [key: string]: any}
function node(tag: string, text = ''): Node {
  const value: Node = {tag, text, children: [], parent: null, props: {}, tagName: tag.toUpperCase(), querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {}, getRootNode: () => (globalThis as any).document, getAttribute: (name: string) => value.props[name], multiple: false}
  Object.defineProperty(value, 'options', {get: () => value.children.filter(child => child.tag === 'option')})
  return value
}
const renderer = createRenderer<Node, Node>({createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(value, parent, anchor) { if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(value); else parent.children.splice(index, 0, value); value.parent = parent },
  remove(value) { if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); value.parent = null }, setText(value, text) {value.text = text}, setElementText(value, text) {value.text = text; value.children = []}, parentNode: value => value.parent, nextSibling: value => value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null, patchProp(value, name, _previous, next) {value.props[name] = next; value[name] = next},
})
async function flush() { for (let index = 0; index < 8; index += 1) await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick() }
async function mountComponent(url: string, env: ReturnType<typeof environment>, props: Record<string, unknown> = {}) {
  ;(globalThis as any)[key] = env
  ;(globalThis as any).HTMLElement = class {}
  ;(globalThis as any).document = {activeElement: null, visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}}
  ;(globalThis as any).window = {addEventListener: () => {}, removeEventListener: () => {}}
  const {default: Component} = await import(url)
  let exposed: any
  const originalSetup = Component.setup
  const component = {...Component, setup(value: unknown, context: any) {return originalSetup(value, {...context, expose(value: any) {exposed = value; context.expose(value)}})}}
  const events: string[] = []
  const app = renderer.createApp({render: () => h(component, {...(url === generatorUrl ? {person: person(), photos: [photo()]} : {}), ...props, onGenerated: () => events.push('generated')})})
  registerComponents(app)
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const tree = node('root'); app.mount(tree); await flush(); assert.deepEqual(warnings, [])
  return {app, exposed, tree, events}
}

test('People profiles show names, descriptions and photo counts with authenticated cached previews', async () => {
  const value = await renderComponent(browserUrl)
  assert.match(value.html, /Alex/); assert.match(value.html, /short auburn hair/); assert.match(value.html, /1 picture/)
  assert.match(value.html, /src="\/api\/data\/images[^\"]+\?preview=480"/)
  assert.doesNotMatch(value.html, /http[s]?:\/\/|Check price/)
})
test('unpriced generated covers and gallery cards stay entirely hidden; pending work is text only', async () => {
  const unpriced = photo({priceSource: 'estimate'})
  const env = environment(() => ({people: [person({cover: unpriced})], nextCursor: null}))
  const value = await renderComponent(browserUrl, {env, initialize: state => {state.activePerson.value = person(); state.photos.value = [unpriced, photo({id: 'priced-zero', url: source.replace('person.png', 'zero.png'), priceUsd: '0'})]; state.pendingCount.value = 2}})
  assert.equal(value.html.includes(`/api/data${source}`), false)
  assert.match(value.html, /2 pictures generating or awaiting exact price/)
  assert.match(value.html, /\$0\.00 · confirmed/)
  assert.doesNotMatch(value.html, /Check price|Confirming price<\/|price pending<\/span>/)
})
test('reference picker preserves product references, deduplicates, and counts every existing selection', async () => {
  const value = await renderComponent(browserUrl, {props: {selectionMode: 'multiple', selectedUrls: [otherSource, otherSource], maxSelection: 2}})
  value.exposed.togglePhoto(photo())
  assert.deepEqual(value.exposed.selection.value, [otherSource, source])
  value.exposed.togglePhoto(photo({url: source.replace('person.png', 'second.png')}))
  assert.equal(value.exposed.selection.value.length, 2)
  value.exposed.confirm()
  assert.deepEqual(value.events.find(event => event.name === 'confirm')?.value, [otherSource, source])
  value.exposed.togglePhoto(photo()); assert.deepEqual(value.exposed.selection.value, [otherSource])
})
test('external and unconfirmed images cannot be added to People reference selections', async () => {
  const value = await renderComponent(browserUrl, {props: {selectedUrls: ['https://example.org/photo.png', '//example.org/photo.png', source]}})
  assert.deepEqual(value.exposed.selection.value, [source])
  value.exposed.togglePhoto(photo({url: source.replace('person.png', 'unconfirmed.png'), priceSource: 'estimate'}))
  assert.deepEqual(value.exposed.selection.value, [source])
})
test('person creation validates bounded metadata and opens the new private profile', async () => {
  const env = environment((url, options) => options.method === 'POST' ? {person: person({name: options.body.name, description: options.body.description})} : url === '/api/people' ? {people: [], nextCursor: null} : detail())
  const value = await renderComponent(browserUrl, {env})
  value.exposed.newName.value = '   '; await value.exposed.createPerson(); assert.equal(env.calls.some(call => call.options.method === 'POST'), false)
  value.exposed.newName.value = ' Alex '; value.exposed.newDescription.value = ' soft freckles '; await value.exposed.createPerson()
  assert.deepEqual(env.calls.find(call => call.options.method === 'POST')?.options.body, {name: 'Alex', description: 'soft freckles'})
  assert.equal(value.exposed.activePerson.value.name, 'Alex')
})
test('person generator uses exact model settings, no product input, identity references and a named prompt', async () => {
  const env = environment((url, options) => url === '/api/image-generate' ? {ok: true, obj: []} : url === '/api/image-models' ? {items: []} : {})
  const value = await renderComponent(generatorUrl, {env, initialize: state => {state.models.value = env.models; state.referenceUrls.value = [source]; state.pictureCount.value = 3}})
  await value.exposed.generate()
  const body = env.calls.find(call => call.url === '/api/image-generate')!.options.body
  assert.equal(body.personId, person().id); assert.equal(body.personPictureCount, 3)
  assert.deepEqual(body.inputImages, []); assert.deepEqual(body.modelImages, [source])
  assert.match(body.prompt, /same adult person/); assert.match(body.prompt, /Person: Alex/); assert.match(body.prompt, /freckles/)
  assert.equal(body.settings.kind, IMAGE_MODEL_PROFILES[body.model as ImageModelId].settingsKind)
  assert.equal(value.events.filter(event => event.name === 'generated').length, 1)
})
test('switching every person-generation model synchronously restores its own settings; mask models are disabled', async () => {
  const value = await mountComponent(generatorUrl, environment())
  for (const model of SUPPORTED_IMAGE_MODEL_IDS) {
    value.exposed.model.value = model
    assert.equal(value.exposed.settings.value.kind, IMAGE_MODEL_PROFILES[model].settingsKind)
    if (IMAGE_MODEL_PROFILES[model].requiresMask) assert.equal(value.exposed.canGenerate.value, false)
  }
  value.app.unmount()
})
test('person batches enforce output count, reference caps, availability and finite account credit before any paid call', async () => {
  const env = environment()
  const value = await renderComponent(generatorUrl, {env, initialize: state => {state.models.value = env.models}})
  value.exposed.model.value = 'openai/gpt-image-2'; value.exposed.settings.value = {...createDefaultSettings('openai/gpt-image-2'), numberOfImages: 3}; value.exposed.pictureCount.value = 2
  assert.equal(value.exposed.canGenerate.value, false); await value.exposed.generate()
  value.exposed.pictureCount.value = 1; assert.equal(value.exposed.canGenerate.value, true)
  env.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}; assert.equal(value.exposed.canGenerate.value, false)
  env.balance.balance.value = {unlimited: false, actualBalanceUsd: '3', outstandingCount: 1}; assert.equal(value.exposed.canGenerate.value, false)
  env.balance.balance.value = {unlimited: true, actualBalanceUsd: null, outstandingCount: 0}; value.exposed.models.value = []; assert.equal(value.exposed.canGenerate.value, false)
  assert.equal(env.calls.some(call => call.url === '/api/image-generate'), false)
})
test('closing a generator keeps its paid request alive and another instance cannot submit the same person', async () => {
  let finish!: (value: unknown) => void
  const env = environment(url => url === '/api/image-generate' ? new Promise(resolve => {finish = resolve}) : {items: SUPPORTED_IMAGE_MODEL_IDS.map(id => ({id, catalogStatus: 'available'}))})
  const first = await mountComponent(generatorUrl, env)
  const running = first.exposed.generate(); await flush()
  const paidRequest = env.calls.find(call => call.url === '/api/image-generate')!
  first.app.unmount(); assert.equal(paidRequest.options.signal.aborted, false)
  const second = await mountComponent(generatorUrl, env)
  assert.equal(second.exposed.canGenerate.value, false); await second.exposed.generate()
  assert.equal(env.calls.filter(call => call.url === '/api/image-generate').length, 1)
  finish({ok: true, obj: []}); await running; await flush()
  assert.equal(second.exposed.canGenerate.value, true); assert.equal(first.events.length, 0)
  second.app.unmount()
})
test('a late old-account response cannot display private People data and clears private form/search state', async () => {
  let finish!: (value: unknown) => void
  const env = environment(() => new Promise(resolve => {finish = resolve}))
  const value = await mountComponent(browserUrl, env)
  value.exposed.newName.value = 'private alias'; value.exposed.newDescription.value = 'private appearance'; value.exposed.search.value = 'old private search'
  env.account.identity.value = 'org.bea'; env.account.epoch.value += 1
  assert.equal(env.calls[0]!.options.signal.aborted, true)
  finish({people: [person()], nextCursor: null}); await flush()
  assert.deepEqual(value.exposed.people.value, []); assert.equal(value.exposed.newName.value, ''); assert.equal(value.exposed.newDescription.value, ''); assert.equal(value.exposed.search.value, '')
  assert.equal(value.exposed.activePerson.value, null); value.app.unmount()
})
test('switching a profile clears old mutation busy flags without applying the previous save', async () => {
  let finish!: (value: unknown) => void
  const env = environment((_url, options) => options.method === 'PATCH' ? new Promise(resolve => {finish = resolve}) : _url === '/api/people' ? {people: [person()], nextCursor: null} : detail())
  const value = await mountComponent(browserUrl, env)
  value.exposed.openPerson(person()); await flush(); value.exposed.editName.value = 'New Alex'
  const saving = value.exposed.savePerson(); assert.equal(value.exposed.saving.value, true)
  value.exposed.back(); value.exposed.openPerson(person({id: '22222222-2222-4222-8222-222222222222', name: 'Sam'})); assert.equal(value.exposed.saving.value, false)
  finish({person: person({name: 'New Alex'})}); await saving; await flush()
  assert.notEqual(value.exposed.activePerson.value?.name, 'New Alex'); value.app.unmount()
})
test('completion during an older pending-zero profile request queues a fresh read and reveals confirmed pictures', async () => {
  let finish!: (value: unknown) => void; let detailReads = 0
  const env = environment(url => url === '/api/people' ? {people: [person()], nextCursor: null} : ++detailReads === 1 ? new Promise(resolve => {finish = resolve}) : detail())
  const value = await mountComponent(browserUrl, env)
  value.exposed.openPerson(person()); value.exposed.generated()
  finish(detail([], {pendingCount: 0})); await flush()
  assert.equal(detailReads, 2); assert.deepEqual(value.exposed.photos.value.map((picture: PersonPhoto) => picture.url), [source]); value.app.unmount()
})
test('quiet price refresh re-reads loaded pages so an inserted photo never drops the displaced page-boundary item', async () => {
  const initial = Array.from({length: 60}, (_, index) => photo({id: `${String(index * 2).padStart(5, '0')}`, url: source.replace('person.png', `${index}.png`)}))
  const inserted = photo({id: '00003', url: source.replace('person.png', 'inserted.png')})
  let changed = false
  const env = environment((url, options) => {
    if (url === '/api/people') return {people: [person()], nextCursor: null}
    const all = changed ? [...initial, inserted].sort((left, right) => left.id.localeCompare(right.id)) : initial
    const offset = options.query.cursor === 'page-2' ? 40 : 0
    return detail(all.slice(offset, offset + 40), {person: person({photoCount: all.length}), nextCursor: offset + 40 < all.length ? 'page-2' : null})
  })
  const value = await mountComponent(browserUrl, env)
  value.exposed.openPerson(person()); await flush(); await value.exposed.loadPerson(person().id, {more: true})
  assert.equal(value.exposed.photos.value.length, 60)
  changed = true; await value.exposed.loadPerson(person().id, {quiet: true})
  assert.equal(value.exposed.photos.value.length, 61)
  for (const picture of initial) assert.equal(value.exposed.photos.value.some((known: PersonPhoto) => known.id === picture.id), true)
  value.app.unmount()
})
test('hidden profiles perform no progress requests and terminal profiles do not poll', async () => {
  const env = environment()
  const value = await mountComponent(browserUrl, env)
  value.exposed.openPerson(person()); await flush()
  const count = env.calls.length
  await value.exposed.pollDetail(); assert.equal(env.calls.length, count)
  value.exposed.pendingCount.value = 1; (globalThis as any).document.visibilityState = 'hidden'; value.exposed.visibilityChanged()
  await value.exposed.pollDetail(); assert.equal(env.calls.length, count)
  value.app.unmount()
})
