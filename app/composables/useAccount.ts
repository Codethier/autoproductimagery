import {publishAccountChange} from '../utils/accountChanges'

export type WorkspaceAccount = {
  userId: string
  organizationId: string
  username: string
  displayName: string
  role: 'owner' | 'user'
  organizationName: string
}

export function useAccount() {
  const account = useState<WorkspaceAccount | null>('workspace-account', () => null)
  const epoch = useState<number>('workspace-account-epoch', () => 0)
  const authenticated = useState<boolean | undefined>('auth-session', () => undefined)
  const identity = computed(() => account.value ? `${account.value.organizationId}.${account.value.userId}` : '')
  const isOwner = computed(() => account.value?.role === 'owner')

  function clear() {
    epoch.value += 1
    account.value = null
    authenticated.value = false
    useDataStore().resetWorkspace()
    clearNuxtData()
  }
  async function load() {
    const currentEpoch = epoch.value
    const next = await useRequestFetch()<WorkspaceAccount>('/api/account/me')
    if (currentEpoch !== epoch.value) return null
    if (account.value && account.value.userId !== next.userId) clear()
    account.value = next
    authenticated.value = true
    return next
  }
  async function signOut() {
    clear()
    try { await $fetch('/api/logout', {method: 'POST'}) }
    finally { if (import.meta.client) publishAccountChange(); await navigateTo('/login', {replace: true}) }
  }
  function notifyTabs() { if (import.meta.client) publishAccountChange() }
  return {account, epoch, identity, isOwner, load, clear, signOut, notifyTabs}
}
