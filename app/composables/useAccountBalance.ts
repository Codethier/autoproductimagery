import type {AccountBalance} from '../../schemas/account-billing'

type BalanceState = {identity: string; epoch: number; request: number; balance: AccountBalance | null; pending: boolean; error: string}

export function useAccountBalance() {
  const account = useAccount()
  const requestFetch = useRequestFetch()
  const state = useState<BalanceState>('workspace-account-balance', () => ({identity: '', epoch: -1, request: 0, balance: null, pending: false, error: ''}))
  const current = computed(() => state.value.identity === account.identity.value && state.value.epoch === account.epoch.value)
  const balance = computed(() => current.value ? state.value.balance : null)
  const pending = computed(() => current.value && state.value.pending)
  const error = computed(() => current.value ? state.value.error : '')
  watch([account.epoch, account.identity], () => {
    if (!current.value) state.value = {identity: '', epoch: -1, request: 0, balance: null, pending: false, error: ''}
  }, {flush: 'sync'})

  async function refresh(options: {force?: boolean} = {}): Promise<AccountBalance | null> {
    const identity = account.identity.value
    const epoch = account.epoch.value
    if (!identity || (!options.force && current.value && state.value.pending)) return null
    const previous = balance.value
    const request = (state.value.request ?? 0) + 1
    state.value = {identity, epoch, request, balance: previous, pending: true, error: ''}
    const stillCurrent = () => account.identity.value === identity && account.epoch.value === epoch
      && state.value.identity === identity && state.value.epoch === epoch && state.value.request === request
    try {
      const response = await requestFetch<AccountBalance>('/api/account/balance', {timeout: 20_000})
      if (stillCurrent()) { state.value.balance = response; return response }
    } catch {
      if (stillCurrent()) state.value.error = 'Could not load your balance. Try again.'
    } finally {
      if (stillCurrent()) state.value.pending = false
    }
    return null
  }
  return {balance, pending, error, refresh}
}
