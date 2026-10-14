import {computed, watch, type Ref} from 'vue'
import {CREDIT_EXHAUSTED_CODE, CREDIT_EXHAUSTED_MESSAGE, parseUsdUnits, type AccountBalance} from '../../schemas/account-billing'

export const CREDIT_UNAVAILABLE_MESSAGE = 'Could not confirm your available credit. Try again before generating.'
export const CREDIT_OUTSTANDING_MESSAGE = 'Your previous prices are still being confirmed. Wait for them to settle before another generation can use your credit.'
export type GenerationCreditState = {identity: string; epoch: number; open: boolean; checking: boolean; reason: string}
export function initialGenerationCreditState(): GenerationCreditState { return {identity: '', epoch: -1, open: false, checking: false, reason: ''} }

export function generationCreditStatus(balance: AccountBalance | null): 'allowed' | 'exhausted' | 'outstanding' | 'unavailable' {
  if (!balance) return 'unavailable'
  if (balance.unlimited) return 'allowed'
  if (balance.actualBalanceUsd === null || balance.actualBalanceUsd.startsWith('-')) return 'exhausted'
  const credit = parseUsdUnits(balance.actualBalanceUsd)
  if (credit === undefined) return 'unavailable'
  if (credit === 0n) return 'exhausted'
  if (balance.generationBlockedByOutstanding ?? balance.outstandingCount > 0) return 'outstanding'
  return 'allowed'
}

export function isCreditExhaustionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as {statusCode?: number; status?: number; data?: {code?: string; data?: {code?: string}}}
  return value.data?.code === CREDIT_EXHAUSTED_CODE || value.data?.data?.code === CREDIT_EXHAUSTED_CODE
    || (value.statusCode ?? value.status) === 402
}

// The state is provided by useState so all generation surfaces share one
// account-scoped prompt and one in-flight balance check.
export function createGenerationCreditController(
  account: {identity: Readonly<Ref<string>>; epoch: Readonly<Ref<number>>},
  balance: {balance: Readonly<Ref<AccountBalance | null>>; refresh: (options?: {force?: boolean}) => Promise<AccountBalance | null>},
  state: Ref<GenerationCreditState>,
) {
  const current = () => state.value.identity === account.identity.value && state.value.epoch === account.epoch.value
  const snapshot = () => ({identity: account.identity.value, epoch: account.epoch.value})
  const sameAccount = (value: ReturnType<typeof snapshot>) => !!value.identity && value.identity === account.identity.value && value.epoch === account.epoch.value
  const bind = () => { if (!current()) state.value = {...initialGenerationCreditState(), ...snapshot()} }
  const open = computed(() => current() && state.value.open)
  const checking = computed(() => current() && state.value.checking)
  const blockedReason = computed(() => current() ? state.value.reason : '')
  const exhausted = computed(() => generationCreditStatus(balance.balance.value) === 'exhausted')
  const outstandingBlocked = computed(() => generationCreditStatus(balance.balance.value) === 'outstanding')
  watch([account.identity, account.epoch], () => { if (!current()) state.value = initialGenerationCreditState() }, {flush: 'sync'})

  function close() { if (current()) state.value.open = false }
  function showExhausted() {
    if (!account.identity.value) return
    bind(); state.value.reason = CREDIT_EXHAUSTED_MESSAGE; state.value.open = true
  }
  async function ensureCredit(): Promise<boolean> {
    if (!account.identity.value || checking.value) return false
    bind(); const value = snapshot(); state.value.checking = true; state.value.reason = ''
    try {
      // Force a new response when a header refresh is in flight. Cached balance
      // and a failed refresh must never authorize a paid action.
      const fresh = await balance.refresh({force: true})
      if (!sameAccount(value)) return false
      const status = generationCreditStatus(fresh)
      if (status === 'exhausted') { showExhausted(); return false }
      if (status === 'outstanding') { state.value.reason = CREDIT_OUTSTANDING_MESSAGE; return false }
      if (status === 'unavailable') { state.value.reason = CREDIT_UNAVAILABLE_MESSAGE; return false }
      return true
    } catch {
      if (sameAccount(value)) state.value.reason = CREDIT_UNAVAILABLE_MESSAGE
      return false
    } finally { if (sameAccount(value)) state.value.checking = false }
  }
  async function handleError(error: unknown): Promise<boolean> {
    if (!isCreditExhaustionError(error) || !account.identity.value) return false
    const value = snapshot(); showExhausted()
    try { await balance.refresh({force: true}) } catch { /* The authoritative refusal still needs its prompt. */ }
    return sameAccount(value)
  }
  return {open, checking, blockedReason, exhausted, outstandingBlocked, ensureCredit, handleError, showExhausted, close}
}
