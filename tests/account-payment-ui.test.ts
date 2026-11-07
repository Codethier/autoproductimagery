import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createRenderer, createSSRApp, effectScope, h, nextTick, ref} from 'vue'
import type {AccountBalance} from '../schemas/account-billing.ts'
import type {AccountPaymentEvent, AccountPaymentList} from '../schemas/account-payments.ts'
import {mergeAccountPaymentEvents} from '../app/utils/accountPaymentEvents.ts'

const root = new URL('../', import.meta.url)
const key = '__accountPaymentUi'
const hookUrl = new URL('app/composables/useAccountPayments.ts', root).href
const historyUrl = new URL('app/components/AccountPaymentHistory.vue', root).href
const balanceUrl = new URL('app/components/AccountBalanceSummary.vue', root).href
const teamUrl = new URL('app/pages/team.vue', root).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('~~/')) return next(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === hookUrl) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed,ref,watch} from 'vue';const useAccount=()=>globalThis.${key}.session;const useRequestFetch=()=>{const env=globalThis.${key};return (...args)=>env.fetch(...args)};${source}`)}
    }
    if (url !== historyUrl && url !== balanceUrl && url !== teamUrl) return next(url, context)
    const filename = fileURLToPath(url)
    let source = readFileSync(filename, 'utf8')
    if (url === historyUrl) source = source.replace('</script>', 'defineExpose({payments})\n</script>')
    if (url === teamUrl) source = source.replace('</script>', 'defineExpose({openBalance,closeBalance,acceptPaymentBalance,balanceDetails,balanceLoading,balanceSaving,balanceTarget,balanceVersion,paymentSaving})\n</script>')
    const {descriptor} = parse(source, {filename})
    const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
    const services = `const useAccount=()=>globalThis.${key}.session;const useAccountBalance=()=>({refresh:async()=>{}});const useFetch=()=>({data:ref({users:[],total:0}),status:ref('success'),error:ref(null),refresh:async()=>{}});const useToast=()=>({add:()=>{}});const definePageMeta=()=>{};const useHead=()=>{};const $fetch=(...args)=>globalThis.${key}.fetch(...args);`
    return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {ref,reactive,watch,toRef,nextTick,onMounted,onBeforeUnmount,onServerPrefetch} from 'vue';import {useAccountPayments} from '${hookUrl}';${services}${compiled.content}`)}
  },
})

const money: AccountBalance = {currency: 'USD', confirmedSpendUsd: '10.000000000000', totalPaidUsd: '5.000000000000', unpaidUsd: '5.000000000000', overpaidUsd: '0.000000000000', outstandingEstimateUsd: '0.070000000000', outstandingCount: 2, outstandingUnknownCount: 1, actualBalanceUsd: null, unlimited: true}
function event(id = 'receipt-1', overrides: Partial<AccountPaymentEvent> = {}): AccountPaymentEvent {
  return {id, userId: 'member', currency: 'USD', amountUsd: '5.000000000000', note: 'Bank transfer', createdAt: '2026-10-14T10:30:00.000Z', recordedBy: {id: 'owner', displayName: 'Pat Owner', username: 'pat'}, ...overrides}
}
function page(events = [event()], nextCursor: string | null = null, balance = money): AccountPaymentList {return {userId: 'member', events, nextCursor, balance}}
function environment(options: {owner?: boolean; fetch?: (url: string, options?: any) => Promise<unknown> | unknown} = {}) {
  const owner = options.owner ?? true
  const calls: Array<{url: string; options: any}> = []
  const session = {account: ref({userId: owner ? 'owner' : 'member', organizationId: 'org'}), epoch: ref(1), identity: ref(owner ? 'org.owner' : 'org.member'), isOwner: ref(owner)}
  const env = {session, calls, fetch: async (url: string, settings: any) => {calls.push({url, options: settings}); return options.fetch ? options.fetch(url, settings) : page()}}
  ;(globalThis as any)[key] = env
  return env
}
async function controller(options: {owner?: boolean; manage?: boolean; fetch?: (url: string, settings?: any) => Promise<unknown> | unknown} = {}) {
  const env = environment(options)
  const {useAccountPayments} = await import(hookUrl)
  const scope = effectScope()
  const target = ref<string | undefined>(options.manage === false ? undefined : 'member')
  const manage = ref(options.manage ?? true)
  const suppliedBalance = ref<AccountBalance | null>(money), balancePending = ref(false), balanceVersion = ref(0)
  const payments = scope.run(() => useAccountPayments(target, manage, suppliedBalance, balancePending, balanceVersion))!
  return {...env, target, manage, suppliedBalance, balancePending, balanceVersion, payments, stop: () => scope.stop()}
}
async function renderHistory(options: {owner?: boolean; manage?: boolean; balance?: AccountBalance; events?: AccountPaymentEvent[]; nextCursor?: string | null; fail?: boolean} = {}) {
  const env = environment({owner: options.owner, fetch: () => {if (options.fail) throw new Error('Internal secret exception'); return page(options.events ?? [event()], options.nextCursor ?? null, options.balance ?? money)}})
  const {default: History} = await import(historyUrl)
  const originalSetup = History.setup
  let exposed: any
  const component = {...History, setup(props: unknown, context: any) {return originalSetup(props, {...context, expose(value: unknown) {exposed = value; context.expose(value)}})}}
  const app = createSSRApp({render: () => h(component, {ownerControls: options.manage ?? false, ...((options.manage ?? false) ? {userId: 'member', balance: options.balance ?? money} : {})})})
  app.component('UIcon', {render: () => h('span')})
  const html = await renderToString(app)
  return {...env, exposed, html}
}

test('members can list their receipts but cannot add, edit, undo or delete a payment', async () => {
  const rendered = await renderHistory({owner: false, events: [event('receipt', {note: '<script>alert("private")</script>'})]})
  assert.match(rendered.html, /Payment history|\$5\.00|Pat Owner|Oct 14, 2026|10:30 AM UTC/)
  assert.match(rendered.html, /&lt;script&gt;alert\(&quot;private&quot;\)&lt;\/script&gt;/)
  assert.doesNotMatch(rendered.html, /<script>|Record payment|Amount received|Undo|Delete|Edit payment/)
  assert.equal(rendered.calls[0]!.url, '/api/account/payments')
  const state = await controller({owner: false, manage: false})
  await state.payments.load()
  state.payments.amountUsd.value = '5'
  await state.payments.record()
  assert.equal(state.calls.length, 1)
  assert.equal(state.payments.events.value[0]!.id, 'receipt-1')
  state.stop()
})

test('owners see a received-payment form only for Unlimited users and retain finite-user history', async () => {
  const unlimited = await renderHistory({owner: true, manage: true})
  assert.match(unlimited.html, /Record a received payment|Amount received \(USD\)|Note \(optional\)|Record payment/)
  assert.match(unlimited.html, /without changing generation credit or the original charges/)
  assert.equal(unlimited.calls[0]!.url, '/api/org/users/member/payments')
  const finite = await renderHistory({owner: true, manage: true, balance: {...money, unlimited: false, actualBalanceUsd: '2.500000000000'}})
  assert.doesNotMatch(finite.html, /Amount received|<form/)
  assert.match(finite.html, /existing payment history stays visible|Bank transfer|\$5\.00/)
  const selfOwner = await renderHistory({owner: true, manage: false})
  assert.doesNotMatch(selfOwner.html, /Record a received payment/)
})

test('bill totals stay separate from finite generation credit and unpriced outstanding work', async () => {
  const {default: Balance} = await import(balanceUrl)
  const app = createSSRApp({render: () => h(Balance, {balance: {...money, confirmedSpendUsd: '10.000000000001', totalPaidUsd: '15.000000000000', unpaidUsd: '0.000000000000', overpaidUsd: '4.999999999999', unlimited: false, actualBalanceUsd: '2.500000000000'}})})
  app.component('UIcon', {render: () => h('span')})
  const html = await renderToString(app)
  for (const label of ['Actual balance', 'Outstanding balance', 'Confirmed spend', 'Total paid', 'Unpaid bills', 'Paid ahead']) assert.match(html, new RegExp(label))
  for (const amount of ['$2.50', '$0.07', '$10.000000000001', '$15.00', '$0.00', '$4.999999999999']) assert.equal(html.includes(amount), true)
  assert.match(html, /2 generations awaiting final cost|1 without an estimate/)
})

test('owner records exact cents and clears the form without changing generation credit', async () => {
  const state = await controller({fetch: (_url, options) => options?.method === 'POST' ? {event: event(), balance: money, created: true} : page()})
  await state.payments.load()
  state.payments.amountUsd.value = '5'
  state.payments.note.value = '  Bank transfer  '
  await state.payments.record()
  const call = state.calls.at(-1)!
  assert.equal(call.url, '/api/org/users/member/payments')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.body.amountUsd, '5.00')
  assert.equal(call.options.body.note, 'Bank transfer')
  assert.match(call.options.body.idempotencyKey, /^[a-f\d-]{36}$/)
  assert.equal(state.payments.events.value.length, 1)
  assert.equal(state.payments.amountUsd.value, '')
  assert.equal(state.payments.note.value, '')
  assert.equal(state.payments.balance.value.actualBalanceUsd, null)
  assert.equal(state.payments.balance.value.confirmedSpendUsd, '10.000000000000')
  assert.equal(state.payments.notice.value, 'Payment recorded.')
  state.stop()
})

test('invalid amounts and excessive notes cannot create payment requests', async () => {
  const state = await controller()
  for (const amount of ['', '0', '-5', '1e3', '5.001', '1000000.01', 'NaN', ' 5 ']) {
    state.payments.amountUsd.value = amount
    await state.payments.record()
    assert.notEqual(state.payments.recordError.value, '')
  }
  state.payments.amountUsd.value = '5.00'
  state.payments.note.value = 'a'.repeat(501)
  await state.payments.record()
  assert.equal(state.calls.length, 0)
  state.stop()
})

test('an uncertain response retries the identical receipt and key even after credit mode changes', async () => {
  let attempts = 0
  const state = await controller({fetch: (_url, options) => {
    if (options?.method !== 'POST') return page()
    if (++attempts === 1) throw new Error('Network connection lost')
    return {event: event(), balance: {...money, unlimited: false, actualBalanceUsd: '4.000000000000'}, created: false}
  }})
  await state.payments.load()
  state.payments.amountUsd.value = '5.00'; state.payments.note.value = 'first'
  await state.payments.record()
  assert.equal(state.payments.uncertain.value, true)
  assert.match(state.payments.recordError.value, /Retry the same payment/)
  const first = structuredClone(state.calls.at(-1)!.options.body)
  state.suppliedBalance.value = {...money, unlimited: false, actualBalanceUsd: '4.000000000000'}
  state.payments.amountUsd.value = '100'; state.payments.note.value = 'must not replace first'
  await state.payments.record()
  assert.deepEqual(state.calls.at(-1)!.options.body, first)
  assert.equal(state.payments.events.value.length, 1)
  assert.equal(state.payments.uncertain.value, false)
  assert.match(state.payments.notice.value, /No duplicate was added/)
  state.stop()
})

test('history appends paginated receipts without duplicates and keeps a failed page retryable', async () => {
  let pageRequest = 0
  const state = await controller({fetch: (_url, options) => {
    if (!options.query.cursor) return page([event('new')], 'next-page')
    if (++pageRequest === 1) throw new Error('network')
    return page([event('new'), event('old', {createdAt: '2026-10-14T10:29:00.000000Z'})], null)
  }})
  await state.payments.load()
  await state.payments.load(true)
  assert.equal(state.payments.events.value.length, 1)
  assert.equal(state.payments.nextCursor.value, 'next-page')
  assert.match(state.payments.error.value, /Could not load more/)
  await state.payments.load(true)
  assert.deepEqual(state.payments.events.value.map((receipt: AccountPaymentEvent) => receipt.id), ['new', 'old'])
  assert.equal(state.payments.nextCursor.value, null)
  assert.deepEqual(state.calls.at(-1)!.options.query, {limit: 25, cursor: 'next-page'})
  state.stop()
})

test('late lists and receipt responses cannot expose a previous account or overwrite a new target', async () => {
  const completions: Array<(value: unknown) => void> = []
  const state = await controller({fetch: () => new Promise(resolve => completions.push(resolve))})
  const first = state.payments.load()
  state.target.value = 'other'
  assert.equal(state.payments.events.value.length, 0)
  assert.equal(state.payments.loading.value, true)
  completions[0]!(page())
  await first
  assert.equal(state.payments.events.value.length, 0)
  assert.equal(state.payments.loading.value, true)
  completions[1]!({...page([event('other-receipt', {userId: 'other'})]), userId: 'other'})
  await nextTick(); await nextTick()
  assert.equal(state.payments.events.value[0]!.id, 'other-receipt')
  state.payments.amountUsd.value = '5'
  const recording = state.payments.record()
  state.session.isOwner.value = false; state.session.account.value = {userId: 'member', organizationId: 'org'}; state.session.identity.value = 'org.member'; state.session.epoch.value += 1
  completions[2]!({event: event(), balance: money, created: true})
  await recording
  assert.equal(state.payments.events.value.length, 0)
  assert.equal(state.payments.balance.value, null)
  assert.equal(state.payments.notice.value, '')
  assert.equal(state.payments.amountUsd.value, '')
  state.stop()
})

test('empty and failed history states remain informative and redact raw failure details', async () => {
  const empty = await renderHistory({owner: false, events: []})
  assert.match(empty.html, /No payments recorded yet|Payments recorded by your organization owner will appear here/)
  const failed = await renderHistory({owner: false, fail: true})
  assert.match(failed.html, /Could not load payment history|Try again/)
  assert.doesNotMatch(failed.html, /Internal secret exception/)
  const paginated = await renderHistory({owner: false, nextCursor: 'page-two'})
  assert.match(paginated.html, /Load more payments/)
})

test('receipt merge preserves full timestamp precision, newest-first order and exact-id deduplication', () => {
  const newer = event('a-newer', {createdAt: '2026-10-14T10:30:00.000002Z'})
  const older = event('z-older', {createdAt: '2026-10-14T10:30:00.000001Z'})
  const tie = event('z-tie', {createdAt: '2026-10-14T10:30:00.000002Z'})
  assert.deepEqual(mergeAccountPaymentEvents([newer, older], [older, tie]).map(value => value.id), ['z-tie', 'a-newer', 'z-older'])
  assert.deepEqual(mergeAccountPaymentEvents([event('whole-ms', {createdAt: '2026-10-14T10:30:00.000Z'})], [newer]).map(value => value.id), ['a-newer', 'whole-ms'])
})

test('double-clicks cannot create two requests and deterministic rejection permits corrected details', async () => {
  let finish!: (value: unknown) => void
  const state = await controller({fetch: (_url, settings) => settings.method === 'POST' ? new Promise(resolve => {finish = resolve}) : page()})
  await state.payments.load()
  state.payments.amountUsd.value = '5'
  const first = state.payments.record()
  await state.payments.record()
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1)
  finish({event: event(), balance: money, created: true})
  await first
  state.stop()

  let requests = 0
  const rejected = await controller({fetch: (_url, settings) => {
    if (settings.method !== 'POST') return page()
    if (++requests === 1) throw Object.assign(new Error('request rejected'), {statusCode: 400})
    return {event: event(), balance: money, created: true}
  }})
  await rejected.payments.load(); rejected.payments.amountUsd.value = '5'
  await rejected.payments.record()
  const key = rejected.calls.at(-1)!.options.body.idempotencyKey
  assert.equal(rejected.payments.uncertain.value, false)
  rejected.payments.amountUsd.value = '6'
  await rejected.payments.record()
  assert.notEqual(rejected.calls.at(-1)!.options.body.idempotencyKey, key)
  assert.equal(rejected.calls.at(-1)!.options.body.amountUsd, '6.00')
  rejected.stop()
})

test('same-user Team balance refresh keeps a pending or uncertain receipt mounted with the same key', async () => {
  let rejectPost!: (failure: unknown) => void
  let postCount = 0
  const env = environment({fetch: (url, settings) => {
    if (settings?.method === 'POST') {
      if (++postCount === 1) return new Promise((_resolve, reject) => {rejectPost = reject})
      return {event: event(), balance: money, created: false}
    }
    return url.endsWith('/balance') ? {userId: 'member', balance: money} : page()
  }})
  const {default: Team} = await import(teamUrl), {default: History} = await import(historyUrl)
  let team: any, history: any, mounts = 0
  const teamSetup = Team.setup, historySetup = History.setup
  const teamComponent = {...Team, setup(props: unknown, context: any) {return teamSetup(props, {...context, expose(value: unknown) {team = value; context.expose(value)}})}}
  const historyComponent = {...History, setup(props: unknown, context: any) {mounts++; return historySetup(props, {...context, expose(value: unknown) {history = value; context.expose(value)}})}}
  type Node = {children: Node[]; parent?: Node; text?: string; addEventListener: () => void; removeEventListener: () => void; getRootNode: () => {activeElement: null}; tagName: string}
  const node = (text = ''): Node => ({children: [], text, addEventListener() {}, removeEventListener() {}, getRootNode: () => ({activeElement: null}), tagName: 'INPUT'})
  const renderer = createRenderer<Node, Node>({
    createElement: () => node(), createText: text => node(text), createComment: text => node(text),
    setText: (item, text) => {item.text = text}, setElementText: (item, text) => {item.text = text; item.children = []},
    parentNode: item => item.parent ?? null, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
    patchProp: () => {}, insert(item, parent, anchor) {if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, item)},
    remove(item) {if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)},
  })
  const app = renderer.createApp({render: () => h(teamComponent)})
  app.component('UIcon', {render: () => h('span')}); app.component('AccountBalanceSummary', {render: () => h('div')}); app.component('AccountPaymentHistory', historyComponent)
  const originalDocument = (globalThis as any).Document, originalShadowRoot = (globalThis as any).ShadowRoot
  ;(globalThis as any).Document = class {}; (globalThis as any).ShadowRoot = class {}
  try {
  app.mount(node())
  const member = {id: 'member', username: 'member', displayName: 'Mira', role: 'user', disabled: false, createdAt: '2026-10-13T00:00:00Z'}
  await team.openBalance(member); await nextTick(); await nextTick()
  assert.equal(mounts, 1)
  history.payments.amountUsd.value = '5'; history.payments.note.value = 'bank'
  const first = history.payments.record()
  assert.equal(team.paymentSaving.value, true)
  team.closeBalance()
  assert.equal(team.balanceTarget.value.id, 'member')
  await team.openBalance({...member, id: 'other'})
  assert.equal(team.balanceTarget.value.id, 'member')
  await team.openBalance(member); await nextTick()
  assert.equal(mounts, 1)
  rejectPost(new Error('lost response')); await first
  assert.equal(history.payments.uncertain.value, true)
  const original = env.calls.find(call => call.options?.method === 'POST')!.options.body
  await team.openBalance(member); await nextTick()
  assert.equal(mounts, 1)
  await history.payments.record()
  const posts = env.calls.filter(call => call.options?.method === 'POST')
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1]!.options.body, original)
  assert.equal(history.payments.events.value.length, 1)
  const actualBalance = team.balanceDetails.value
  const obsolete = {userId: 'other', epoch: env.session.epoch.value, identity: env.session.identity.value, version: team.balanceVersion.value, balance: {...money, totalPaidUsd: '999.000000000000'}}
  team.acceptPaymentBalance(obsolete)
  assert.equal(team.balanceDetails.value, actualBalance)
  team.acceptPaymentBalance({...obsolete, userId: 'member', epoch: 0})
  assert.equal(team.balanceDetails.value, actualBalance)
  team.balanceSaving.value = true
  team.acceptPaymentBalance({...obsolete, userId: 'member'})
  assert.equal(team.balanceDetails.value, actualBalance)
  team.balanceSaving.value = false
  team.acceptPaymentBalance({...obsolete, userId: 'member', version: 0})
  assert.equal(team.balanceDetails.value, actualBalance)
  env.fetch = async (url, settings) => {
    if (url.endsWith('/balance')) throw new Error('primary balance unavailable')
    return {...page([], null, {...money, unlimited: false, actualBalanceUsd: '7.500000000000'}), userId: 'finite'}
  }
  await team.openBalance({...member, id: 'finite'})
  for (let flush = 0; flush < 5; flush++) await nextTick()
  assert.equal(team.balanceDetails.value, null, 'successful payment history must not expose a stale credit-form draft after the primary balance failed')
  assert.equal(history.payments.canRecord.value, false)
  } finally {app.unmount(); (globalThis as any).Document = originalDocument; (globalThis as any).ShadowRoot = originalShadowRoot}
})

test('a pre-save payment list cannot overwrite newer generation credit after the credit setter finishes', async () => {
  const replies: Array<(response: unknown) => void> = []
  const state = await controller({fetch: () => new Promise(resolve => replies.push(resolve))})
  const oldList = state.payments.load()
  state.balancePending.value = true
  state.balanceVersion.value += 1
  const credit = {...money, unlimited: false, actualBalanceUsd: '12.500000000000'}
  state.suppliedBalance.value = credit
  state.balancePending.value = false
  assert.equal(replies.length, 2)
  replies[1]!(page([event('new')], null, credit))
  for (let flush = 0; flush < 5; flush++) await nextTick()
  assert.equal(state.payments.balance.value!.actualBalanceUsd, '12.500000000000')
  assert.equal(state.payments.balanceReadVersion.value, 1)
  replies[0]!(page([event('obsolete')], null, money))
  await oldList
  assert.equal(state.payments.balance.value!.actualBalanceUsd, '12.500000000000')
  assert.equal(state.payments.events.value[0]!.id, 'new')
  assert.equal(state.payments.canRecord.value, false)
  state.stop()
})
