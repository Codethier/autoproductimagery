import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {compileScript, compileTemplate, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createSSRApp, computed, h, ref, watch} from 'vue'
import {transpileModule, ModuleKind, ScriptTarget} from 'typescript'
import {createDefaultSettings} from '../schemas/image-generation.ts'

// Render the actual history card with Nuxt composables and image/API components
// stubbed. The image URL remains in expired records, so a DOM assertion catches
// accidental downloads/refinements even when the retained metadata looks valid.
const source = readFileSync(new URL('../app/components/systemPromp.vue', import.meta.url), 'utf8')
const {descriptor} = parse(source)
const script = compileScript(descriptor, {id: 'retention-history-test'})
const template = compileTemplate({
  id: 'retention-history-test', filename: 'systemPromp.vue', source: descriptor.template!.content,
  compilerOptions: {bindingMetadata: script.bindings},
})
assert.deepEqual(template.errors, [])
const vueUrl = new URL('../node_modules/vue/index.mjs', import.meta.url).href
const schemaUrl = new URL('../schemas/image-generation.ts', import.meta.url).href
const billingSchemaUrl = new URL('../schemas/generation-billing.ts', import.meta.url).href
const priceFormatterUrl = new URL('../app/utils/generationPrice.ts', import.meta.url).href
const combined = `${script.content.replace('export default', 'const component =')}
${template.code.replace('export function render', 'function render')}
component.render = render;
export default component;`
  .replace(/import\s*\{\s*refreshNuxtData\s*\}\s*from\s*['"]#app['"]/g, 'const refreshNuxtData = (...args) => globalThis.refreshNuxtData(...args)')
  .replace(/(['"])~~\/schemas\/image-generation\1/g, JSON.stringify(schemaUrl))
  .replace(/(['"])~~\/schemas\/generation-billing\1/g, JSON.stringify(billingSchemaUrl))
  .replace(/(['"])\.\.\/utils\/generationPrice\1/g, JSON.stringify(priceFormatterUrl))
  .replace(/(['"])vue\1/g, JSON.stringify(vueUrl))
const javascript = transpileModule(combined, {
  compilerOptions: {module: ModuleKind.ESNext, target: ScriptTarget.ES2022},
}).outputText
const {default: component} = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

const config = {
  schemaVersion: 1, profileVersion: 1, requestedModel: 'google/gemini-3-pro-image',
  effectiveModel: 'google/gemini-3-pro-image', settings: createDefaultSettings('google/gemini-3-pro-image'),
  storeInputImages: true,
}
const output = '/images/output/img-1750000000000-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png'
const original = {
  id: 1, TextPrompt: 'Photograph the product', outputImage: output,
  generationModel: config.effectiveModel, generationConfig: config,
  serverImages: ['/images/products/product.png'], modelImages: [],
  createdAt: '2026-01-01T00:00:00.000Z', status: 'succeeded',
  priceUsd: '0.04500000', priceSource: 'gateway', billingState: 'confirmed',
}

async function renderCard(data: Record<string, unknown>, history: Record<string, unknown>[] = [], fetcher?: (url: string, options?: unknown) => Promise<unknown>) {
  const notifications: Record<string, unknown>[] = []
  const account = {identity: ref('studio.alice'), epoch: ref(1)}
  const historyKeys: string[] = []
  const refreshedKeys: string[] = []
  let bindings: any
  const injected: Record<string, unknown> = {
    computed, ref, watch,
    useAccount: () => account,
    useNuxtData: (key: string) => { historyKeys.push(key); return {data: ref({items: history})} },
    refreshNuxtData: async (key: string) => { refreshedKeys.push(key) },
    useToast: () => ({add: (notification: Record<string, unknown>) => notifications.push(notification)}),
    $fetch: fetcher ?? (async () => {throw new Error('Unexpected API request')}),
  }
  const previous = new Map(Object.keys(injected).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(injected)) Object.defineProperty(globalThis, key, {value, configurable: true})
  const testedComponent = {...component, setup(props: unknown, context: unknown) {
    bindings = component.setup(props, context)
    return bindings
  }}
  const app = createSSRApp(testedComponent, {data})
  app.component('DownloadableImage', {props: ['src', 'alt'], setup: (props: any) => () => h('img', {src: props.src, alt: props.alt})})
  app.component('UButton', {inheritAttrs: false, setup: (_: unknown, {attrs, slots}: any) => () => h('button', attrs, slots.default?.())})
  for (const name of ['UInput', 'UTextarea', 'UIcon']) app.component(name, {setup: () => () => h('span')})
  try {
    const html = await renderToString(app)
    return {html, bindings, notifications, account, historyKeys, refreshedKeys, restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }}
  } catch (error) {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    throw error
  }
}

test('expired generated images retain history and regeneration while hiding the output download and refinement', async () => {
  const card = await renderCard({...original, outputImageDeletedAt: '2026-10-12T01:00:00.000Z'})
  try {
    assert.match(card.html, /Image expired/)
    assert.match(card.html, /The prompt, settings, and generation history are retained/)
    assert.equal(card.html.includes(output), false)
    assert.doesNotMatch(card.html, />Refine</)
    const regenerateButton = card.html.match(/<button([^>]*)>\s*Regenerate\s*<\/button>/)
    assert.ok(regenerateButton)
    assert.doesNotMatch(regenerateButton[1]!, /disabled/)
    assert.equal(card.bindings.replayUnavailableReason.value, '')
  } finally {card.restore()}
})

test('an available generated output still renders its image and refinement controls', async () => {
  const card = await renderCard({...original, outputImageDeletedAt: null})
  try {
    assert.equal(card.html.includes(output), true)
    assert.match(card.html, />Refine</)
    assert.doesNotMatch(card.html, /Image expired/)
  } finally {card.restore()}
})

test('an expired output can be regenerated from the preserved uploaded source with its original settings', async () => {
  const calls: Array<{url: string; options: any}> = []
  const replacement = '/images/output/img-1760000000000-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png'
  const card = await renderCard({...original, outputImageDeletedAt: '2026-10-12T01:00:00.000Z'}, [], async (url, options) => {
    calls.push({url, options})
    return {ok: true, obj: [{...original, id: 2, outputImage: replacement}]}
  })
  try {
    await card.bindings.regenerate()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, '/api/image-generate')
    assert.deepEqual(calls[0]!.options.body.inputImages, original.serverImages)
    assert.deepEqual(calls[0]!.options.body.settings, config.settings)
    assert.equal(card.bindings.currentImage.value, replacement)
    assert.equal(card.bindings.outputImageExpired.value, false)
  } finally {card.restore()}
})

test('exact legacy refinement replay refuses an expired parent before making a generation request', async () => {
  const card = await renderCard({...original, id: 2, serverImages: [], parentSystemPromptId: 1}, [
    {...original, outputImageDeletedAt: '2026-10-12T01:00:00.000Z'},
  ])
  try {
    await card.bindings.regenerate()
    assert.equal(card.notifications[0]?.title, 'Cannot reproduce this refinement')
    assert.match(String(card.notifications[0]?.description), /generated source image expired/)
  } finally {card.restore()}
})

test('exact legacy refinement replay recognizes an expired parent fetched outside the history page', async () => {
  const calls: string[] = []
  const card = await renderCard({...original, id: 2, serverImages: [], parentSystemPromptId: 1}, [], async url => {
    calls.push(url)
    return {ok: true, item: {...original, outputImageDeletedAt: '2026-10-12T01:00:00.000Z'}}
  })
  try {
    await card.bindings.regenerate()
    assert.deepEqual(calls, ['/api/systemprompts/1'])
    assert.equal(card.notifications[0]?.title, 'Cannot reproduce this refinement')
    assert.match(String(card.notifications[0]?.description), /generated source image expired/)
  } finally {card.restore()}
})

test('retention errors from generation sources are visible when an exact replay fails', async () => {
  const reason = 'A generated source image has expired. Exact replay is unavailable.'
  const card = await renderCard(original, [], async () => {throw {data: {statusMessage: reason}}})
  const previousConsoleError = console.error
  console.error = () => {}
  try {
    await card.bindings.regenerate()
    assert.equal(card.notifications[0]?.title, 'Regeneration failed')
    assert.equal(card.notifications[0]?.description, reason)
  } finally {console.error = previousConsoleError; card.restore()}
})

test('history card caches and billing refreshes use the original account and session namespace', async () => {
  const card = await renderCard(original, [], async () => ({ok: true, item: original}))
  try {
    assert.deepEqual(card.historyKeys, ['systemPrompts:studio.alice:1'])
    await card.bindings.refreshBilling()
    assert.deepEqual(card.refreshedKeys, ['systemPrompts:studio.alice:1'])
  } finally {card.restore()}
})

test('generated image markup is withheld for pending and estimated prices, including an output URL already in the response', async () => {
  for (const billing of [
    {priceUsd: null, priceSource: null, billingState: 'pending'},
    {priceUsd: '0.03000000', priceSource: 'estimate', billingState: 'pending'},
    {priceUsd: '0.04500000', priceSource: 'gateway', billingState: 'pending'},
  ]) {
    const card = await renderCard({...original, ...billing})
    try {
      assert.equal(card.html.includes(output), false)
      assert.match(card.html, /Image ready · confirming price/)
      assert.match(card.html, /Price:/)
      assert.doesNotMatch(card.html, />Refine</)
      assert.equal(card.bindings.currentImage.value, null)
    } finally {card.restore()}
  }
})

test('a confirmed zero price unlocks the generated output and displays the exact free price', async () => {
  const card = await renderCard({...original, priceUsd: '0.00000000'})
  try {
    assert.equal(card.html.includes(output), true)
    assert.match(card.html, /\$0\.00/)
    assert.match(card.html, /confirmed/)
  } finally {card.restore()}
})

test('billing refresh unlocks a pending result only when the reloaded generation is confirmed', async () => {
  let confirmed = false
  const card = await renderCard({...original, priceSource: 'estimate', billingState: 'pending'}, [], async url => ({ok: true,
    item: {...original, billingState: confirmed ? 'confirmed' : 'pending'}}))
  try {
    assert.equal(card.bindings.currentImage.value, null)
    await card.bindings.refreshBilling()
    assert.equal(card.bindings.currentImage.value, null)
    confirmed = true
    await card.bindings.refreshBilling()
    assert.equal(card.bindings.currentImage.value, output)
  } finally {card.restore()}
})

test('an old history card refuses details, billing, refinement and regeneration after an account change', async () => {
  const calls: string[] = []
  const card = await renderCard(original, [], async url => { calls.push(url); return {ok: true} })
  try {
    card.account.identity.value = 'studio.bea'
    card.account.epoch.value += 1
    card.bindings.chatInput.value = 'Use a warmer light'
    await card.bindings.loadOutputDetails()
    await card.bindings.refreshBilling()
    await card.bindings.sendRefine()
    await card.bindings.regenerate()
    assert.equal(card.bindings.cardIsCurrent.value, false)
    assert.deepEqual(calls, [])
    assert.deepEqual(card.notifications, [])
    assert.deepEqual(card.refreshedKeys, [])
  } finally {card.restore()}
})

test('late output details and billing responses never populate a new account or refresh its cache', async () => {
  for (const action of ['loadOutputDetails', 'refreshBilling'] as const) {
    let finish!: (value: unknown) => void
    const card = await renderCard(original, [], () => new Promise(resolve => {finish = resolve}))
    try {
      const pending = card.bindings[action]()
      card.account.identity.value = 'studio.bea'
      card.account.epoch.value += 1
      finish({ok: true, item: {...original, outputMetadata: {responseText: 'Private provider details'}}})
      await pending
      assert.equal(card.bindings.detailData.value, null)
      assert.deepEqual(card.notifications, [])
      assert.deepEqual(card.refreshedKeys, [])
    } finally {card.restore()}
  }
})

test('late refinement results are ignored and repeated regeneration stops before another paid request on account change', async () => {
  for (const action of ['sendRefine', 'regenerate'] as const) {
    let finish!: (value: unknown) => void
    const calls: string[] = []
    const card = await renderCard(original, [], url => {calls.push(url); return new Promise(resolve => {finish = resolve})})
    try {
      card.bindings.chatInput.value = 'Use a warmer light'
      card.bindings.regenCount.value = 3
      const pending = card.bindings[action]()
      assert.deepEqual(calls, ['/api/image-generate'])
      card.account.identity.value = 'studio.bea'
      card.account.epoch.value += 1
      const replacement = '/images/output/previous-user-result.png'
      finish({ok: true, obj: [{...original, outputImage: replacement}]})
      await pending
      assert.equal(calls.length, 1)
      assert.notEqual(card.bindings.currentImage.value, replacement)
      assert.deepEqual(card.notifications, [])
      assert.deepEqual(card.refreshedKeys, [])
    } finally {card.restore()}
  }
})

test('legacy parent replay cannot continue into generation after the account changes during its detail lookup', async () => {
  let finish!: (value: unknown) => void
  const calls: string[] = []
  const card = await renderCard({...original, id: 2, serverImages: [], parentSystemPromptId: 1}, [], url => {
    calls.push(url); return new Promise(resolve => {finish = resolve})
  })
  try {
    const pending = card.bindings.regenerate()
    assert.deepEqual(calls, ['/api/systemprompts/1'])
    card.account.epoch.value += 1
    finish({ok: true, item: original})
    await pending
    assert.deepEqual(calls, ['/api/systemprompts/1'])
    assert.deepEqual(card.notifications, [])
    assert.deepEqual(card.refreshedKeys, [])
  } finally {card.restore()}
})
