type PeopleGenerationProgress = {token: string; identity: string; epoch: number; personId: string; startedAt: number}

// This is a UI submit guard, shared across route changes. Durable generation
// ownership, admission and billing remain enforced by the authenticated server.
export function usePeopleGenerationProgress() {
  const account = useAccount()
  const entries = useState<PeopleGenerationProgress[]>('people-generation-progress', () => [])
  const pending = computed(() => entries.value.filter(entry => entry.identity === account.identity.value && entry.epoch === account.epoch.value))
  watch([account.epoch, account.identity], () => {
    entries.value = entries.value.filter(entry => entry.identity === account.identity.value && entry.epoch === account.epoch.value)
  }, {flush: 'sync'})
  function running(personId: string) { return pending.value.some(entry => entry.personId === personId) }
  function claim(personId: string) {
    if (!account.identity.value || running(personId)) return null
    const token = crypto.randomUUID()
    entries.value = [...entries.value, {token, identity: account.identity.value, epoch: account.epoch.value, personId, startedAt: Date.now()}]
    return token
  }
  function release(token: string) { entries.value = entries.value.filter(entry => entry.token !== token) }
  return {pending, count: computed(() => pending.value.length), running, claim, release}
}
