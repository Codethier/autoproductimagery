import type {AccountBalance} from '../../schemas/account-billing'

type BalanceState = {identity: string; epoch: number; balance: AccountBalance | null; pending: boolean; error: string}

export function useAccountBalance() {
  const account = useAccount()
  const requestFetch = useRequestFetch()
  const state = useState<BalanceState>('workspace-account-balance', () => ({identity: '', epoch: -1, balance: null, pending: false, error: ''}))
  const current = computed(() => state.value.identity === account.identity.value && state.value.epoch === account.epoch.value)
  const balance = computed(() => current.value ? state.value.balance : null)
  const pending = computed(() => current.value && state.value.pending)
  const error = computed(() => current.value ? state.value.error : '')
  watch([account.epoch, account.identity], () => {
    if (!current.value) state.value = {identity: '', epoch: -1, balance: null, pending: false, error: ''}
  }, {flush: 'sync'})

  async function refresh() {
    const identity = account.identity.value
    const epoch = account.epoch.value
    if (!identity || (current.value && state.value.pending)) return
    const previous = balance.value
    state.value = {identity, epoch, balance: previous, pending: true, error: ''}
    const stillCurrent = () => account.identity.value === identity && account.epoch.value === epoch
      && state.value.identity === identity && state.value.epoch === epoch
    try {
      const response = await requestFetch<AccountBalance>('/api/account/balance')
      if (stillCurrent()) state.value.balance = response
    } catch {
      if (stillCurrent()) state.value.error = 'Could not load your balance. Try again.'
    } finally {
      if (stillCurrent()) state.value.pending = false
    }
  }
  return {balance, pending, error, refresh}
}
