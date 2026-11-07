import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {computed, createRenderer, createSSRApp, effectScope, h, nextTick, ref, watch} from 'vue'
import {CREDIT_EXHAUSTED_CODE, CREDIT_EXHAUSTED_MESSAGE, type AccountBalance} from '../schemas/account-billing.ts'
import {createGenerationCreditController, generationCreditStatus, initialGenerationCreditState, isCreditExhaustionError,
    CREDIT_OUTSTANDING_MESSAGE, CREDIT_UNAVAILABLE_MESSAGE} from '../app/utils/generationCredit.ts'
import {serverlessFetchOptions, SERVERLESS_READ_ATTEMPT_MS} from '../app/utils/serverlessRequests.ts'

const root = new URL('../', import.meta.url)
const dialogUrl = new URL('app/components/GenerationCreditDialog.vue', root).href
const environmentKey = '__generationCreditDialogTest'
registerHooks({
    load(url, context, nextLoad) {
        if (url !== dialogUrl) return nextLoad(url, context)
        const filename = fileURLToPath(url)
        const source = readFileSync(filename, 'utf8').replace('</script>', 'defineExpose({keydown, panel, viewBalance, manageBalances})\n</script>')
        const {descriptor} = parse(source, {filename})
        const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
        return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`
            import {ref, watch, nextTick, onMounted, onBeforeUnmount} from 'vue';
            const useGenerationCredit = () => globalThis.${environmentKey}.credit;
            const useAccount = () => globalThis.${environmentKey}.account;
            const useAccountBalance = () => globalThis.${environmentKey}.balance;
            const navigateTo = value => globalThis.${environmentKey}.navigate(value);
            ${compiled.content}`)}
    },
})

function money(actualBalanceUsd: string | null, extra: Partial<AccountBalance> = {}): AccountBalance {
    return {currency: 'USD', confirmedSpendUsd: '0.000000000000', totalPaidUsd: '0.000000000000', unpaidUsd: '0.000000000000',
        overpaidUsd: '0.000000000000', outstandingEstimateUsd: '0.000000000000', outstandingCount: 0, outstandingUnknownCount: 0,
        actualBalanceUsd, unlimited: actualBalanceUsd === null, generationBlockedByOutstanding: false, ...extra}
}
function creditFixture(initial = money(null), refresh?: (options?: {force?: boolean}) => Promise<AccountBalance | null>) {
    const account = {identity: ref('org.alice'), epoch: ref(1), isOwner: ref(false)}
    const balance = {balance: ref<AccountBalance | null>(initial), refresh: refresh ?? (async () => balance.balance.value)}
    const state = ref(initialGenerationCreditState())
    const scope = effectScope()
    const credit = scope.run(() => createGenerationCreditController(account, balance, state))!
    return {account, balance, state, scope, credit}
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((accept, fail) => {resolve = accept; reject = fail})
    return {promise, resolve, reject}
}

test('generation credit distinguishes exact zero, negative, tiny positive, unlimited and outstanding amounts', () => {
    assert.equal(generationCreditStatus(null), 'unavailable')
    for (const value of ['0', '0.000000000000', '-0.000000000001', '-4.35']) assert.equal(generationCreditStatus(money(value)), 'exhausted')
    assert.equal(generationCreditStatus(money('0.000000000001')), 'allowed', 'one accounting unit must not be rounded to zero')
    assert.equal(generationCreditStatus(money('1', {generationBlockedByOutstanding: true, outstandingCount: 2})), 'outstanding')
    assert.equal(generationCreditStatus(money('1', {generationBlockedByOutstanding: false, outstandingCount: 2})), 'allowed')
    assert.equal(generationCreditStatus(money('1', {generationBlockedByOutstanding: undefined, outstandingCount: 1})), 'outstanding')
    assert.equal(generationCreditStatus(money(null, {outstandingCount: 3, generationBlockedByOutstanding: true})), 'allowed')
    assert.equal(generationCreditStatus(money('invalid')), 'unavailable')
})

test('only exhausted-credit refusals open the balance notice; outstanding and other failures remain distinct', () => {
    for (const error of [{statusCode: 402}, {status: 402}, {data: {code: CREDIT_EXHAUSTED_CODE}}, {data: {data: {code: CREDIT_EXHAUSTED_CODE}}}]) {
        assert.equal(isCreditExhaustionError(error), true)
    }
    for (const error of [null, 'credit exhausted', {statusCode: 409}, {status: 429}, {data: {code: 'WORK_BLOCKED'}}, new Error('Network unavailable')]) {
        assert.equal(isCreditExhaustionError(error), false)
    }
})

test('fresh zero credit refuses authorization and opens one shared notice; restored and unlimited credit permit new work', async () => {
    const fresh = ref<AccountBalance | null>(money('0'))
    const calls: unknown[] = []
    const fixture = creditFixture(money('5'), async options => {calls.push(options); return fresh.value})
    try {
        assert.equal(await fixture.credit.ensureCredit(), false)
        assert.equal(fixture.credit.open.value, true)
        assert.equal(fixture.credit.blockedReason.value, CREDIT_EXHAUSTED_MESSAGE)
        assert.equal(fixture.credit.checking.value, false)
        assert.deepEqual(calls, [{force: true}])
        fixture.credit.close()
        assert.equal(fixture.credit.open.value, false)
        fresh.value = money('0.000000000001')
        assert.equal(await fixture.credit.ensureCredit(), true)
        assert.equal(fixture.credit.open.value, false)
        fresh.value = money(null)
        assert.equal(await fixture.credit.ensureCredit(), true)
    } finally {fixture.scope.stop()}
})

test('a failed fresh balance check never authorizes from cached positive credit or claims it is exhausted', async () => {
    for (const fail of [false, true]) {
        const fixture = creditFixture(money('500'), async () => {if (fail) throw new Error('Network failed'); return null})
        try {
            assert.equal(await fixture.credit.ensureCredit(), false)
            assert.equal(fixture.credit.blockedReason.value, CREDIT_UNAVAILABLE_MESSAGE)
            assert.equal(fixture.credit.open.value, false)
            assert.equal(fixture.balance.balance.value?.actualBalanceUsd, '500')
            assert.equal(fixture.credit.checking.value, false)
        } finally {fixture.scope.stop()}
    }
})

test('outstanding-price authorization is refused without displaying the exhausted-credit popup', async () => {
    const fixture = creditFixture(money('2'), async () => money('2', {generationBlockedByOutstanding: true, outstandingCount: 1}))
    try {
        assert.equal(await fixture.credit.ensureCredit(), false)
        assert.equal(fixture.credit.blockedReason.value, CREDIT_OUTSTANDING_MESSAGE)
        assert.equal(fixture.credit.open.value, false)
        assert.equal(await fixture.credit.handleError({statusCode: 409}), false)
    } finally {fixture.scope.stop()}
})

test('shared generation controllers prevent simultaneous balance checks and discard a result after an account change', async () => {
    const pending = deferred<AccountBalance | null>()
    let calls = 0
    const fixture = creditFixture(money('1'), async () => {calls++; return pending.promise})
    const sibling = fixture.scope.run(() => createGenerationCreditController(fixture.account, fixture.balance, fixture.state))!
    try {
        const first = fixture.credit.ensureCredit()
        assert.equal(sibling.checking.value, true)
        assert.equal(await sibling.ensureCredit(), false)
        assert.equal(calls, 1)
        fixture.account.identity.value = 'org.bea'; fixture.account.epoch.value += 1
        pending.resolve(money('0'))
        assert.equal(await first, false)
        assert.equal(fixture.credit.open.value, false)
        assert.equal(sibling.checking.value, false)
        assert.deepEqual(fixture.state.value, initialGenerationCreditState())
    } finally {fixture.scope.stop()}
})

test('an authoritative HTTP credit refusal opens immediately even when the subsequent balance read fails', async () => {
    const pending = deferred<AccountBalance | null>()
    const fixture = creditFixture(money('1'), async () => pending.promise)
    try {
        const handled = fixture.credit.handleError({statusCode: 402, data: {data: {code: CREDIT_EXHAUSTED_CODE}}})
        assert.equal(fixture.credit.open.value, true)
        pending.reject(new Error('Balance endpoint unavailable'))
        assert.equal(await handled, true)
        assert.equal(fixture.credit.open.value, true)
        fixture.account.epoch.value += 1
        assert.equal(fixture.credit.open.value, false)
    } finally {fixture.scope.stop()}
})

function balanceFixture() {
    const source = stripTypeScriptTypes(readFileSync(new URL('app/composables/useAccountBalance.ts', root), 'utf8'))
        .replace(/import \{serverlessFetchOptions\} from '[^']+'/, '')
        .replace('export function useAccountBalance', 'return function useAccountBalance')
    const account = {identity: ref('org.alice'), epoch: ref(1)}
    const requests: Array<ReturnType<typeof deferred<AccountBalance>>> = []
    const transport: Array<{url: string; options: unknown}> = []
    const state = ref<any>()
    const scope = effectScope()
    const factory = new Function('computed', 'watch', 'useAccount', 'useState', 'useRequestFetch', 'serverlessFetchOptions', source)
    const balance = scope.run(() => factory(computed, watch, () => account, (_key: string, initial: () => unknown) => {state.value ??= initial(); return state},
        () => (url: string, options: any) => {options.onRequest?.({options}); transport.push({url, options}); const request = deferred<AccountBalance>(); requests.push(request); return request.promise}, serverlessFetchOptions)())
    return {account, balance, requests, transport, scope}
}

test('a forced balance refresh supersedes a pending header response and returns only its own current result', async () => {
    const fixture = balanceFixture()
    try {
        const header = fixture.balance.refresh()
        assert.equal(await fixture.balance.refresh(), null)
        assert.equal(fixture.requests.length, 1)
        const forced = fixture.balance.refresh({force: true})
        assert.equal(fixture.requests.length, 2)
        assert.deepEqual(fixture.transport.map(({url, options}: any) => ({url, timeout: options.timeout, retry: options.retry, epoch: options.workspaceAccountEpoch})), [
            {url: '/api/account/balance', timeout: SERVERLESS_READ_ATTEMPT_MS, retry: 1, epoch: 1},
            {url: '/api/account/balance', timeout: SERVERLESS_READ_ATTEMPT_MS, retry: 1, epoch: 1},
        ])
        fixture.requests[0]!.resolve(money('500'))
        assert.equal(await header, null)
        assert.equal(fixture.balance.balance.value, null)
        assert.equal(fixture.balance.pending.value, true)
        fixture.requests[1]!.resolve(money('0'))
        assert.deepEqual(await forced, money('0'))
        assert.equal(fixture.balance.balance.value.actualBalanceUsd, '0')
        assert.equal(fixture.balance.pending.value, false)
    } finally {fixture.scope.stop()}
})

test('a bounded balance transport timeout clears pending state and cannot authorize paid work from cached positive credit', async () => {
    const fixture = balanceFixture()
    try {
        const initial = fixture.balance.refresh()
        fixture.requests[0]!.resolve(money('5'))
        await initial
        let freshResponse: AccountBalance | null | undefined
        const checkedBalance = {balance: fixture.balance.balance, async refresh(options?: {force?: boolean}) {
            freshResponse = await fixture.balance.refresh(options); return freshResponse
        }}
        const credit = fixture.scope.run(() => createGenerationCreditController(fixture.account, checkedBalance, ref(initialGenerationCreditState())))!
        const authorization = credit.ensureCredit()
        assert.equal(fixture.balance.pending.value, true)
        const transport = fixture.transport.at(-1)! as {url: string; options: any}
        assert.equal(transport.url, '/api/account/balance')
        assert.equal(transport.options.timeout, SERVERLESS_READ_ATTEMPT_MS)
        assert.equal(transport.options.workspaceRequestState.budget, 90_000)
        fixture.requests[1]!.reject(Object.assign(new Error('Request timed out'), {name: 'TimeoutError'}))
        assert.equal(await authorization, false)
        assert.equal(freshResponse, null)
        assert.equal(fixture.balance.pending.value, false)
        assert.equal(fixture.balance.balance.value.actualBalanceUsd, '5', 'displayed cached credit is not an authorization')
        assert.equal(fixture.balance.error.value, 'Could not load your balance. Try again.')
        assert.equal(credit.blockedReason.value, CREDIT_UNAVAILABLE_MESSAGE)
        assert.equal(credit.open.value, false, 'a transport timeout must not claim the account has no credit')
        assert.equal(credit.checking.value, false)
    } finally {fixture.scope.stop()}
})

test('late prior-account balance replies cannot replace a new account balance or clear its pending state', async () => {
    const fixture = balanceFixture()
    try {
        const old = fixture.balance.refresh({force: true})
        fixture.account.identity.value = 'org.bea'; fixture.account.epoch.value += 1
        const current = fixture.balance.refresh({force: true})
        fixture.requests[0]!.resolve(money('900'))
        assert.equal(await old, null)
        assert.equal(fixture.balance.balance.value, null)
        assert.equal(fixture.balance.pending.value, true)
        fixture.requests[1]!.resolve(money(null))
        assert.deepEqual(await current, money(null))
        assert.equal(fixture.balance.balance.value.unlimited, true)
        assert.equal(fixture.balance.pending.value, false)
    } finally {fixture.scope.stop()}
})

async function renderDialog(owner: boolean) {
    const fixture = creditFixture(money('0'))
    fixture.account.isOwner.value = owner
    fixture.credit.showExhausted()
    const navigations: string[] = []
    ;(globalThis as any)[environmentKey] = {...fixture, navigate: async (path: string) => navigations.push(path)}
    const {default: Component} = await import(dialogUrl)
    let exposed: any
    const component = {...Component, setup(props: unknown, context: any) {
        return Component.setup(props, {...context, expose(value: any) {exposed = value; context.expose(value)}})
    }}
    const app = createSSRApp({render: () => h(component)})
    app.component('UIcon', {render: () => h('span', {'aria-hidden': 'true'})})
    const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
    const html = await renderToString(app)
    assert.deepEqual(warnings, [])
    return {...fixture, exposed, html, navigations}
}

test('the actual balance popup has accessible labels, exact available credit and role-appropriate actions', async () => {
    for (const owner of [false, true]) {
        const dialog = await renderDialog(owner)
        try {
            assert.match(dialog.html, /role="alertdialog" aria-modal="true" aria-labelledby="generation-credit-title" aria-describedby="generation-credit-description"/)
            assert.match(dialog.html, /More balance needed/)
            assert.match(dialog.html, /Available credit/)
            assert.match(dialog.html, /\$0\.00/)
            assert.match(dialog.html, /View balance/)
            if (owner) {assert.match(dialog.html, /Manage balances/); assert.match(dialog.html, /Add credit from Team/)}
            else {assert.doesNotMatch(dialog.html, /Manage balances/); assert.match(dialog.html, /Ask your organization owner/)}
            await dialog.exposed.viewBalance()
            assert.equal(dialog.credit.open.value, false)
            assert.deepEqual(dialog.navigations, ['/account'])
            if (owner) {dialog.credit.showExhausted(); await dialog.exposed.manageBalances(); assert.deepEqual(dialog.navigations, ['/account', '/team'])}
        } finally {dialog.scope.stop()}
    }
})

test('the actual popup traps Tab, closes with Escape and blocks underlying editor shortcuts', async () => {
    const dialog = await renderDialog(false)
    const documentBefore = (globalThis as any).document
    const focus: string[] = []
    const first = {focus: () => focus.push('first')}, last = {focus: () => focus.push('last')}
    ;(globalThis as any).document = {activeElement: first}
    dialog.exposed.panel.value = {querySelectorAll: () => [first, last], contains: (element: unknown) => element === first || element === last}
    const event = (key: string, shiftKey = false) => ({key, shiftKey, prevented: false, stopped: false,
        preventDefault() {this.prevented = true}, stopPropagation() {this.stopped = true}})
    try {
        const reverse = event('Tab', true); dialog.exposed.keydown(reverse)
        assert.equal(reverse.prevented, true); assert.equal(reverse.stopped, true); assert.deepEqual(focus, ['last'])
        ;(globalThis as any).document.activeElement = last
        const forward = event('Tab'); dialog.exposed.keydown(forward)
        assert.equal(forward.prevented, true); assert.equal(forward.stopped, true); assert.deepEqual(focus, ['last', 'first'])
        const save = event('s'); dialog.exposed.keydown(save)
        assert.equal(save.stopped, true, 'editor shortcuts must not receive popup keystrokes')
        const escape = event('Escape'); dialog.exposed.keydown(escape)
        assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.equal(dialog.credit.open.value, false)
        const closed = event('Tab'); dialog.exposed.keydown(closed)
        assert.equal(closed.stopped, false)
        await nextTick()
    } finally {(globalThis as any).document = documentBefore; dialog.scope.stop()}
})

test('the mounted popup remembers Generate before a pending check drops focus to body and restores it after Escape', async () => {
    const documentBefore = (globalThis as any).document, windowBefore = (globalThis as any).window, elementBefore = (globalThis as any).HTMLElement
    const listeners = new Map<string, (event: any) => void>()
    class FocusNode {
        readonly __v_skip = true
        parent: FocusNode | null = null
        children: FocusNode[] = []
        props: Record<string, any> = {}
        text = ''
        disabled = false
        isConnected = true
        readonly tag: string
        constructor(tag: string) {this.tag = tag}
        focus() {
            if (this.disabled || !this.isConnected) return
            ;(globalThis as any).document.activeElement = this
            listeners.get('focusin')?.({target: this})
        }
        contains(target: unknown): boolean {return target === this || this.children.some(child => child.contains(target))}
        querySelectorAll(): FocusNode[] {
            const children = this.children.flatMap(child => [child, ...child.querySelectorAll()])
            return children.filter(child => child.tag === 'button' && !child.disabled)
        }
        querySelector(): FocusNode | null {return this.querySelectorAll()[0] ?? null}
    }
    const renderer = createRenderer<FocusNode, FocusNode>({
        createElement: tag => new FocusNode(tag), createText: text => Object.assign(new FocusNode('#text'), {text}), createComment: text => Object.assign(new FocusNode('#comment'), {text}),
        insert(value, parent, anchor) {
            if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1)
            const index = anchor ? parent.children.indexOf(anchor) : -1
            if (index < 0) parent.children.push(value); else parent.children.splice(index, 0, value)
            value.parent = parent; value.isConnected = true
        },
        remove(value) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); value.parent = null; value.isConnected = false},
        setText(value, text) {value.text = text}, setElementText(value, text) {value.text = text; value.children = []},
        parentNode: value => value.parent, nextSibling: value => value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null,
        patchProp(value, name, _previous, next) {value.props[name] = next; if (name === 'disabled') value.disabled = Boolean(next)},
    })
    const body = new FocusNode('body'), generate = new FocusNode('button')
    ;(globalThis as any).HTMLElement = FocusNode
    ;(globalThis as any).document = {body, documentElement: new FocusNode('html'), activeElement: body}
    ;(globalThis as any).window = {addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
        removeEventListener: (name: string, handler: (event: any) => void) => {if (listeners.get(name) === handler) listeners.delete(name)}}
    const fixture = creditFixture(money('0'))
    ;(globalThis as any)[environmentKey] = {...fixture, navigate: async () => undefined}
    const {default: Component} = await import(dialogUrl)
    const app = renderer.createApp({render: () => h(Component)})
    app.component('UIcon', {render: () => h('span')})
    const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
    try {
        app.mount(new FocusNode('root'))
        generate.focus()
        assert.equal((globalThis as any).document.activeElement, generate)
        generate.disabled = true
        ;(globalThis as any).document.activeElement = body
        listeners.get('focusin')?.({target: body})
        fixture.credit.showExhausted()
        generate.disabled = false
        await nextTick(); await nextTick()
        assert.notEqual((globalThis as any).document.activeElement, body, 'the opened popup must receive focus')
        assert.notEqual((globalThis as any).document.activeElement, generate)
        listeners.get('keydown')!({key: 'Escape', preventDefault() {}, stopPropagation() {}})
        await nextTick(); await nextTick()
        assert.equal(fixture.credit.open.value, false)
        assert.equal((globalThis as any).document.activeElement, generate, 'restore the origin captured before the browser lost focus')
        assert.deepEqual(warnings, [])
        app.unmount()
        assert.equal(listeners.has('focusin'), false)
        assert.equal(listeners.has('keydown'), false)
    } finally {
        if (listeners.size) app.unmount()
        fixture.scope.stop()
        ;(globalThis as any).document = documentBefore
        ;(globalThis as any).window = windowBefore
        ;(globalThis as any).HTMLElement = elementBefore
    }
})
