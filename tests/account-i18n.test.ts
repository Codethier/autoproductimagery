import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {CREDIT_EXHAUSTED_MESSAGE} from '../schemas/account-billing.ts'
import {generationPriceLabel} from '../app/utils/generationPrice.ts'
import {pipelineJobRerunBlockedReason} from '../app/utils/pipelineCredit.ts'
import {CREDIT_OUTSTANDING_MESSAGE, CREDIT_UNAVAILABLE_MESSAGE} from '../app/utils/generationCredit.ts'
import {serverOrKeyMessage, uiMessageText} from '../app/utils/uiMessage.ts'
import {hasMessage, translate, useI18n} from './i18n-test-helpers.ts'

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const accountFiles = ['app/pages/login.vue', 'app/pages/account.vue', 'app/pages/team.vue', 'app/error.vue', 'app/components/AccountBalanceSummary.vue',
  'app/components/AccountPaymentHistory.vue', 'app/components/GenerationCreditDialog.vue', 'app/composables/useAccountPayments.ts',
  'app/composables/useAccountBalance.ts', 'app/plugins/auth-fetch.ts', 'app/utils/generationPrice.ts', 'app/utils/pipelineCredit.ts', 'app/utils/generationCredit.ts']

test('every account-area message key used in source exists in English and Hungarian', () => {
  const keys = new Set<string>()
  for (const file of accountFiles) for (const match of source(file).matchAll(/['`]((?:account|common)\.[A-Za-z]+(?:\.[A-Za-z]+)+)['`]/g)) keys.add(match[1]!)
  assert.ok(keys.size > 100, `found ${keys.size} keys`)
  for (const key of keys) {
    assert.ok(hasMessage(key, 'en'), `en ${key}`)
    assert.ok(hasMessage(key, 'hu'), `hu ${key}`)
  }
})

test('signed-out visitors can switch language and the sign-in copy is localized', () => {
  const login = source('app/pages/login.vue')
  assert.match(login, /<LanguageSwitcher \/>/)
  assert.match(login, /useHead\(\{title: computed\(\(\) => t\('account\.login\.pageTitle'\)\)\}\)/)
  for (const english of ['Sign in', 'Username is required', 'Your password', 'From product photo']) assert.doesNotMatch(login.replace(/<style[\s\S]*$/, ''), new RegExp(`['>]${english}`))
  assert.equal(translate('account.login.submit'), 'Sign in')
  assert.equal(translate('account.login.submit', {}, 'hu'), 'Bejelentkezés')
  assert.equal(translate('account.login.invalidCredentials'), 'We couldn’t sign you in. Check your username and password and try again.')
})

test('node-safe English fallbacks match the English locale and callers can pass the active translator', () => {
  const en = useI18n('en').t, hu = useI18n('hu').t
  const confirmed = {priceUsd: '0.050000000000', priceSource: 'gateway', billingState: 'confirmed'}
  const estimate = {priceUsd: '0.050000000000', priceSource: 'estimate', billingState: 'pending'}
  for (const row of [confirmed, estimate, {priceUsd: null, priceSource: null, billingState: 'pending'}]) {
    assert.equal(generationPriceLabel(row), generationPriceLabel(row, en))
    assert.notEqual(generationPriceLabel(row, hu), generationPriceLabel(row))
  }
  assert.equal(generationPriceLabel(estimate, hu), '$0.05 · becslés, a végleges ár függőben')
  const run: any = {cancelRequested: false, definition: {nodes: [], edges: []}, items: [{id: 'item', status: 'failed', steps: []}]}
  assert.equal(pipelineJobRerunBlockedReason(run, 'item'), translate('account.rerun.notCompleted'))
  assert.equal(pipelineJobRerunBlockedReason(run, 'item', hu), translate('account.rerun.notCompleted', {}, 'hu'))
  assert.equal(translate('account.credit.exhausted'), CREDIT_EXHAUSTED_MESSAGE)
  assert.equal(translate('account.credit.outstanding'), CREDIT_OUTSTANDING_MESSAGE)
  assert.equal(translate('account.credit.unavailable'), CREDIT_UNAVAILABLE_MESSAGE)
})

test('stored client messages re-render in the current language while server explanations stay verbatim', () => {
  const fallback = serverOrKeyMessage(new Error('internal detail'), 'account.team.saveFailed')
  assert.deepEqual(fallback, {key: 'account.team.saveFailed'})
  assert.equal(uiMessageText(fallback, useI18n('en').t), 'The account could not be saved. Please try again.')
  assert.equal(uiMessageText(fallback, useI18n('hu').t), translate('account.team.saveFailed', {}, 'hu'))
  const server = serverOrKeyMessage({data: {statusMessage: 'That username is already in use'}}, 'account.team.saveFailed')
  assert.equal(uiMessageText(server, useI18n('hu').t), 'That username is already in use')
  assert.equal(uiMessageText(null, useI18n('en').t), '')
})

test('team and balance copy uses placeholders and separate singular/plural keys', () => {
  assert.equal(translate('account.team.pagination', {start: 51, end: 100, total: 120}), '51–100 of 120')
  assert.equal(translate('account.team.balanceTitle', {name: 'Mira'}, 'hu'), 'Mira generálási egyenlege')
  assert.equal(translate('account.balance.awaitingOne', {count: 1}), '1 generation awaiting final cost')
  assert.equal(translate('account.balance.awaitingOther', {count: 2}), '2 generations awaiting final cost')
  assert.match(translate('account.team.invalidUsername'), /@/)
  const balance = source('app/components/AccountBalanceSummary.vue')
  assert.match(balance, /balance\.outstandingCount === 1 \? 'account\.balance\.awaitingOne' : 'account\.balance\.awaitingOther'/)
})
