import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {compileScript, compileTemplate, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createRenderer, createSSRApp, computed, h, nextTick, reactive, ref, watch} from 'vue'
import {transpileModule, ModuleKind, ScriptTarget} from 'typescript'
import {createDefaultSettings} from '../schemas/image-generation.ts'
import {createGenerationCreditController, initialGenerationCreditState} from '../app/utils/generationCredit.ts'

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

type MemoryNode = {tag: string; text: string; children: MemoryNode[]; parent: MemoryNode | null; props: Record<string, unknown>}
function memoryNode(tag: string, text = ''): MemoryNode { return {tag, text, children: [], parent: null, props: {}} }
const memoryRenderer = createRenderer<MemoryNode, MemoryNode>({
  createElement: tag => memoryNode(tag), createText: text => memoryNode('#text', text), createComment: text => memoryNode('#comment', text),
  insert(node, parent, anchor) {
    if (node.parent) {
      const previous = node.parent.children.indexOf(node)
      if (previous !== -1) node.parent.children.splice(previous, 1)
    }
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index === -1) parent.children.push(node); else parent.children.splice(index, 0, node)
    node.parent = parent
  },
  remove(node) {
    if (node.parent) {
      const index = node.parent.children.indexOf(node)
      if (index !== -1) node.parent.children.splice(index, 1)
    }
    node.parent = null
  },
  setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp(node, key, _old, value) { node.props[key] = value },
})
function descendants(node: MemoryNode): MemoryNode[] { return [node, ...node.children.flatMap(descendants)] }

async function renderCard(data: Record<string, unknown>, history: Record<string, unknown>[] = [], fetcher?: (url: string, options?: unknown) => Promise<unknown>, client = false) {
  const notifications: Record<string, unknown>[] = []
  const account = {identity: ref('studio.alice'), epoch: ref(1)}
  const balance = {balance: ref<any>({unlimited: true, actualBalanceUsd: null, outstandingCount: 0}), refresh: async function () {return this.balance.value}}
  const credit = createGenerationCreditController(account, balance, ref(initialGenerationCreditState()))
  const historyKeys: string[] = []
  const refreshedKeys: string[] = []
  let bindings: any
  const injected: Record<string, unknown> = {
    computed, ref, watch,
    useAccount: () => account,
    useGenerationCredit: () => credit,
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
  const cardData = ref(data)
  const app = client ? memoryRenderer.createApp({render: () => h(testedComponent, {data: cardData.value})}) : createSSRApp(testedComponent, {data})
  app.component('DownloadableImage', {props: ['src', 'alt'], setup: (props: any) => () => h('img', {src: props.src, alt: props.alt})})
  app.component('UButton', {inheritAttrs: false, setup: (_: unknown, {attrs, slots}: any) => () => h('button', attrs, slots.default?.())})
  for (const name of ['UInput', 'UTextarea', 'UIcon']) app.component(name, {setup: () => () => h('span')})
  try {
    const rootNode = memoryNode('root')
    let html = ''
    if (client) { app.mount(rootNode); await nextTick() }
    else html = await renderToString(app)
    return {html, rootNode, bindings, notifications, account, balance, credit, historyKeys, refreshedKeys,
      setData: (nextData: Record<string, unknown>) => {cardData.value = nextData}, restore: () => {
      if (client) app.unmount()
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
    assert.match(card.html, /prompt and settings are retained/)
    assert.equal(card.html.includes(output), false)
    assert.doesNotMatch(card.html, /class="generation-refinement"/)
    const regenerateButton = card.html.match(/<button([^>]*class="generation-regenerate-button"[^>]*)>[\s\S]*?Regenerate[\s\S]*?<\/button>/)
    assert.ok(regenerateButton)
    assert.doesNotMatch(regenerateButton[1]!, /disabled/)
    assert.equal(card.bindings.replayUnavailableReason.value, '')
  } finally {card.restore()}
})

test('an available generated output still renders its image and refinement controls', async () => {
  const card = await renderCard({...original, outputImageDeletedAt: null})
  try {
    assert.equal(card.html.includes(output), true)
    assert.match(card.html, /Refine this image/)
    assert.match(card.html, /class="generation-refinement"/)
    assert.doesNotMatch(card.html, /Image expired/)
    assert.match(card.html, /<article[^>]*class="[^"]*generation-result-card/)
    assert.doesNotMatch(card.html, /Check prices?|dark:bg-gray-|bg-gray-/)
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

test('history card regeneration refreshes the original account and session namespace', async () => {
  const card = await renderCard(original, [], async () => ({ok: true, obj: [original]}))
  try {
    assert.deepEqual(card.historyKeys, ['systemPrompts:studio.alice:1'])
    await card.bindings.regenerate()
    assert.deepEqual(card.refreshedKeys, ['systemPrompts:studio.alice:1'])
  } finally {card.restore()}
})

test('a generation without an exact confirmed price renders no card, even with retained images and metadata', async () => {
  for (const billing of [
    {priceUsd: null, priceSource: null, billingState: 'pending'},
    {priceUsd: '0.03000000', priceSource: 'estimate', billingState: 'pending'},
    {priceUsd: '0.04500000', priceSource: 'gateway', billingState: 'pending'},
    {priceUsd: null, priceSource: 'gateway', billingState: 'confirmed'},
    {priceUsd: '-0.01000000', priceSource: 'gateway', billingState: 'confirmed'},
    {priceUsd: 'not-a-price', priceSource: 'gateway', billingState: 'confirmed'},
    {priceUsd: '0.0450000000001', priceSource: 'gateway', billingState: 'confirmed'},
    {priceUsd: '0.04500000', priceSource: 'gateway', billingState: 'confirmed', usageJson: {gatewayBilling: {isByok: true}}},
    {priceUsd: null, priceSource: null, billingState: 'awaiting', outputImageDeletedAt: '2026-10-12T01:00:00.000Z'},
  ]) {
    const card = await renderCard({...original, ...billing})
    try {
      assert.equal(card.html.includes(output), false)
      assert.equal(card.html.includes(original.serverImages[0]!), false)
      assert.equal(card.html.includes(original.TextPrompt), false)
      assert.doesNotMatch(card.html, /<(?:article|div|button|img)\b/)
      assert.doesNotMatch(card.html, /Image ready|Price:|Refine|Regenerate|Check prices?/)
      assert.equal(card.bindings.currentImage.value, null)
    } finally {card.restore()}
  }
})

test('a confirmed zero price unlocks the generated output and displays the exact free price', async () => {
  const card = await renderCard({...original, priceUsd: '0.00000000'})
  try {
    assert.equal(card.html.includes(output), true)
    assert.match(card.html, /\$0\.00/)
    assert.match(card.html, /Final price/)
  } finally {card.restore()}
})

test('automatic history updates reveal a result only after its exact price is confirmed, including a zero charge', async () => {
  const data = reactive({...original, priceSource: 'estimate', billingState: 'pending'})
  const calls: string[] = []
  const card = await renderCard(data, [], async url => {calls.push(url); throw new Error('A result card must not query billing')}, true)
  try {
    assert.equal(card.bindings.currentImage.value, null)
    assert.equal(descendants(card.rootNode).some(node => node.tag === 'article'), false)
    card.setData({...data, priceSource: 'gateway'})
    await nextTick()
    assert.equal(card.bindings.currentImage.value, null)
    assert.equal(descendants(card.rootNode).some(node => node.tag === 'article'), false)
    card.setData({...data, priceSource: 'gateway', priceUsd: '0.00000000', billingState: 'confirmed'})
    await nextTick()
    assert.equal(card.bindings.currentImage.value, output)
    const elements = descendants(card.rootNode)
    assert.equal(elements.some(node => node.tag === 'article'), true)
    assert.equal(elements.some(node => node.tag === 'img' && node.props.src === output), true)
    assert.match(elements.map(node => node.text).join(' '), /\$0\.00/)
    assert.doesNotMatch(elements.map(node => node.text).join(' '), /Check prices?|Pending confirmation/)
    assert.deepEqual(calls, [])
  } finally {card.restore()}
})

test('a late confirmed price cannot reveal a hidden card after its account session changes', async () => {
  const data = reactive({...original, priceUsd: null as string | null, priceSource: null as string | null, billingState: 'awaiting'})
  const card = await renderCard(data, [], undefined, true)
  try {
    assert.equal(descendants(card.rootNode).some(node => node.tag === 'article'), false)
    card.account.identity.value = 'studio.bea'
    card.account.epoch.value += 1
    data.priceUsd = '0.045000000000'
    data.priceSource = 'gateway'
    data.billingState = 'confirmed'
    await nextTick()
    assert.equal(card.bindings.cardIsCurrent.value, false)
    assert.equal(descendants(card.rootNode).some(node => node.tag === 'article' || node.tag === 'img'), false)
    assert.deepEqual(card.notifications, [])
    assert.deepEqual(card.refreshedKeys, [])
  } finally {card.restore()}
})

test('unpriced regenerated derivatives do not replace a confirmed card or trigger manual billing requests', async () => {
  const confirmedReplacement = '/images/output/confirmed-replacement.png'
  const unpricedReplacement = '/images/output/unpriced-replacement.png'
  const calls: Array<{url: string; options: any}> = []
  const card = await renderCard(original, [], async (url, options) => {
    calls.push({url, options})
    return {ok: true, obj: [{...original, id: calls.length + 1,
      outputImage: calls.length === 1 ? confirmedReplacement : unpricedReplacement,
      priceSource: calls.length === 1 ? 'gateway' : 'estimate',
      billingState: calls.length === 1 ? 'confirmed' : 'awaiting'}]}
  })
  try {
    card.bindings.regenCount.value = 2
    await card.bindings.regenerate()
    assert.equal(card.bindings.currentImage.value, confirmedReplacement)
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url === '/api/image-generate'))
    assert.ok(calls.every(call => call.options.body.model === config.effectiveModel))
    assert.ok(calls.every(call => JSON.stringify(call.options.body.settings) === JSON.stringify(config.settings)))
    assert.ok(calls.every(call => JSON.stringify(call.options.body.inputImages) === JSON.stringify(original.serverImages)))
    assert.deepEqual(card.refreshedKeys, ['systemPrompts:studio.alice:1'])
    assert.equal(card.notifications[0]?.title, 'Regeneration started')
  } finally {card.restore()}
})

test('a refinement awaiting price keeps its confirmed source and exact model settings', async () => {
  const calls: Array<{url: string; options: any}> = []
  const card = await renderCard(original, [], async (url, options) => {
    calls.push({url, options})
    return {ok: true, obj: [{...original, id: 2, outputImage: '/images/output/unpriced-refinement.png',
      priceSource: 'estimate', billingState: 'awaiting'}]}
  })
  try {
    card.bindings.chatInput.value = 'Use a warmer light'
    await card.bindings.sendRefine()
    assert.equal(card.bindings.currentImage.value, output)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, '/api/image-generate')
    assert.deepEqual(calls[0]!.options.body.inputImages, [output])
    assert.equal(calls[0]!.options.body.model, config.effectiveModel)
    assert.deepEqual(calls[0]!.options.body.settings, config.settings)
    assert.equal(card.notifications[0]?.title, 'Refinement created · price pending')
    assert.deepEqual(card.refreshedKeys, ['systemPrompts:studio.alice:1'])
  } finally {card.restore()}
})

test('an old history card refuses details, refinement and regeneration after an account change', async () => {
  const calls: string[] = []
  const card = await renderCard(original, [], async url => { calls.push(url); return {ok: true} })
  try {
    card.account.identity.value = 'studio.bea'
    card.account.epoch.value += 1
    card.bindings.chatInput.value = 'Use a warmer light'
    await card.bindings.loadOutputDetails()
    await card.bindings.sendRefine()
    await card.bindings.regenerate()
    assert.equal(card.bindings.cardIsCurrent.value, false)
    assert.deepEqual(calls, [])
    assert.deepEqual(card.notifications, [])
    assert.deepEqual(card.refreshedKeys, [])
  } finally {card.restore()}
})

test('late output details never populate a new account or refresh its cache', async () => {
  for (const action of ['loadOutputDetails'] as const) {
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

test('refine and regenerate refuse zero credit before prompts or paid requests and preserve input on a raced 402', async () => {
  for (const action of ['sendRefine', 'regenerate'] as const) {
    const calls: string[] = []; const card = await renderCard(original, [], async url => {calls.push(url); return {ok: true, obj: [original]}})
    try {
      card.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}
      card.bindings.chatInput.value = 'Use a warmer light'
      await card.bindings[action]()
      assert.deepEqual(calls, []); assert.equal(card.credit.open.value, true); assert.deepEqual(card.notifications, [])
      assert.equal(card.bindings.chatInput.value, 'Use a warmer light')
    } finally {card.restore()}
  }
  const card = await renderCard(original, [], async () => {throw {statusCode: 402, data: {code: 'CREDIT_EXHAUSTED'}}})
  try {
    card.bindings.chatInput.value = 'Keep this refinement'
    await card.bindings.sendRefine()
    assert.equal(card.credit.open.value, true); assert.deepEqual(card.notifications, [])
    assert.equal(card.bindings.chatInput.value, 'Keep this refinement')
  } finally {card.restore()}
})

test('repeated regeneration stops before a second paid request when exact usage uses up the credit', async () => {
  const calls: string[] = []
  const card = await renderCard(original, [], async url => {
    calls.push(url); card.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}
    return {ok: true, obj: [original]}
  })
  try {
    card.balance.balance.value = {unlimited: false, actualBalanceUsd: '1', outstandingCount: 0}; card.bindings.regenCount.value = 3
    await card.bindings.regenerate()
    assert.equal(calls.length, 1); assert.equal(card.credit.open.value, true); assert.deepEqual(card.notifications, [])
  } finally {card.restore()}
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
      await new Promise(resolve => setImmediate(resolve))
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
