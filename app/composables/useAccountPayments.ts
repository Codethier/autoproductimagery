import {RecordAccountPaymentSchema, type AccountPaymentEvent, type AccountPaymentList, type RecordedAccountPayment} from '../../schemas/account-payments'
import type {AccountBalance} from '../../schemas/account-billing'
import {mergeAccountPaymentEvents} from '../utils/accountPaymentEvents'

// Payment attempts stay in this component's memory. A lost response must retry
// the same immutable request instead of recording the receipt a second time.
export function useAccountPayments(targetUserId: Ref<string | undefined>, ownerControls: Ref<boolean>, providedBalance: Ref<AccountBalance | null | undefined>, balancePending: Ref<boolean> = ref(false), balanceVersion: Ref<number> = ref(0)) {
  const session = useAccount()
  const requestFetch = useRequestFetch()
  const events = ref<AccountPaymentEvent[]>([])
  const balance = ref<AccountBalance | null>(null)
  const balanceReadVersion = ref(balanceVersion.value)
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const saving = ref(false)
  const error = ref('')
  const recordError = ref('')
  const notice = ref('')
  const amountUsd = ref('')
  const note = ref('')
  const attempt = ref<ReturnType<typeof RecordAccountPaymentSchema.parse> | null>(null)
  const uncertain = ref(false)
  const userId = computed(() => targetUserId.value ?? session.account.value?.userId)
  const context = computed(() => `${session.identity.value}:${session.epoch.value}:${userId.value ?? ''}:${ownerControls.value}`)
  const canManage = computed(() => ownerControls.value && session.isOwner.value && Boolean(userId.value))
  const canRecord = computed(() => canManage.value && !balancePending.value && (providedBalance.value === undefined ? balance.value : providedBalance.value)?.unlimited === true)
  let loadRequest = 0
  let stateContext = context.value

  function reset() {
    ++loadRequest
    stateContext = context.value
    events.value = []; balance.value = null; nextCursor.value = null
    loading.value = false; loaded.value = false; saving.value = false
    error.value = ''; recordError.value = ''; notice.value = ''
    amountUsd.value = ''; note.value = ''; attempt.value = null; uncertain.value = false
  }
  watch(context, () => {reset(); void load()}, {flush: 'sync'})
  watch([balancePending, balanceVersion], () => {++loadRequest; loading.value = false; if (!balancePending.value) void load()}, {flush: 'sync'})
  const endpoint = computed(() => ownerControls.value ? `/api/org/users/${encodeURIComponent(userId.value ?? '')}/payments` : '/api/account/payments')
  const stillCurrent = (stamp: string) => stamp === context.value && stamp === stateContext

  async function load(more = false) {
    if (!userId.value || loading.value || saving.value || (ownerControls.value && (!canManage.value || balancePending.value)) || (more && !nextCursor.value)) return
    const stamp = context.value
    const request = ++loadRequest
    const readVersion = balanceVersion.value
    const cursor = more ? nextCursor.value : null
    loading.value = true; error.value = ''
    try {
      const response = await requestFetch<AccountPaymentList>(endpoint.value, {query: {limit: 25, ...(cursor ? {cursor} : {})}})
      if (!stillCurrent(stamp) || request !== loadRequest || response.userId !== userId.value) return
      events.value = mergeAccountPaymentEvents(more ? events.value : [], response.events)
      balanceReadVersion.value = readVersion; balance.value = response.balance; nextCursor.value = response.nextCursor; loaded.value = true
    } catch {
      if (stillCurrent(stamp) && request === loadRequest) error.value = more ? 'Could not load more payments. Try again.' : 'Could not load payment history. Try again.'
    } finally {
      if (stillCurrent(stamp) && request === loadRequest) loading.value = false
    }
  }

  async function record() {
    if (saving.value || !canManage.value || (!attempt.value && !canRecord.value)) return
    recordError.value = ''; notice.value = ''
    if (!attempt.value) {
      const parsed = RecordAccountPaymentSchema.safeParse({amountUsd: amountUsd.value, note: note.value, idempotencyKey: crypto.randomUUID()})
      if (!parsed.success) { recordError.value = parsed.error.issues[0]?.message ?? 'Enter a positive USD amount with at most two decimal places.'; return }
      attempt.value = parsed.data
    }
    const body = {...attempt.value}
    const stamp = context.value
    const readVersion = balanceVersion.value
    const target = userId.value
    ++loadRequest; loading.value = false; saving.value = true
    try {
      const response = await requestFetch<RecordedAccountPayment>(endpoint.value, {method: 'POST', body})
      if (!stillCurrent(stamp) || response.event.userId !== target) return
      events.value = mergeAccountPaymentEvents(events.value, [response.event])
      balanceReadVersion.value = readVersion; balance.value = response.balance
      attempt.value = null; uncertain.value = false; amountUsd.value = ''; note.value = ''
      notice.value = response.created ? 'Payment recorded.' : 'Payment already recorded. No duplicate was added.'
    } catch (failure) {
      if (!stillCurrent(stamp)) return
      const status = (failure as {statusCode?: number; status?: number; response?: {status?: number}}).statusCode
        ?? (failure as {status?: number}).status ?? (failure as {response?: {status?: number}}).response?.status
      if ([400, 401, 403, 404, 409, 422].includes(status ?? 0)) {
        attempt.value = null; uncertain.value = false
        recordError.value = status === 409 ? 'This account no longer has Unlimited credit. Refresh its balance before recording a payment.'
          : status === 403 ? 'Only an organization owner can record payments for users in this organization.'
          : 'The payment was not recorded. Check the amount and account, then try again.'
      } else {
        uncertain.value = true
        recordError.value = 'We could not confirm whether this payment was recorded. Retry the same payment to check safely.'
      }
    } finally {
      if (stillCurrent(stamp)) saving.value = false
    }
    // A first receipt still needs a list request to obtain the older-history cursor.
    if (stillCurrent(stamp) && (!loaded.value || readVersion !== balanceVersion.value) && !attempt.value) await load()
  }

  return {events, balance, balanceReadVersion, nextCursor, loading, loaded, saving, error, recordError, notice, amountUsd, note, uncertain, canRecord, load, record, reset}
}
