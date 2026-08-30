export default defineNuxtPlugin(() => {
  if (!import.meta.client) return

  const router = useRouter()
  const authenticated = useState<boolean | undefined>('auth-session', () => undefined)
  const baseFetch = $fetch
  let loggingOut = false

  async function logout(reason: 'unauthorized' | 'forbidden') {
    if (loggingOut) return
    loggingOut = true
    authenticated.value = false

    // Only the server can clear the HttpOnly session cookie.
    await baseFetch('/api/logout', { method: 'POST' }).catch(() => undefined)

    const current = router.currentRoute.value
    if (current.path === '/login') {
      loggingOut = false
      return
    }

    try {
      const toast = useToast()
      toast.add({
        title: 'Signed out',
        description: reason === 'forbidden' ? 'Access denied.' : 'Your session is no longer valid. Please sign in again.',
        color: 'warning'
      })
    } catch {}

    const redirect = current.fullPath && current.fullPath !== '/' ? `?redirect=${encodeURIComponent(current.fullPath)}` : ''
    await navigateTo(`/login${redirect}`, { replace: true })
    loggingOut = false
  }

  globalThis.$fetch = baseFetch.create({
    onResponseError({ response }) {
      const status = response?.status
      if (status === 401) return logout('unauthorized')
      if (status === 403) return logout('forbidden')
    }
  })
})
