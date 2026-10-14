import {prepareServerlessRequest, SERVERLESS_MUTATION_TIMEOUT_MS} from '../utils/serverlessRequests'

export default defineNuxtPlugin(() => {
  if (!import.meta.client) return

  const router = useRouter()
  const session = useAccount()
  const baseFetch = $fetch
  let loggingOut = false

  async function logout() {
    if (loggingOut) return
    loggingOut = true
    session.clear()

    // Only the server can clear the HttpOnly session cookie.
    await baseFetch('/api/logout', {method: 'POST', retry: 0, timeout: SERVERLESS_MUTATION_TIMEOUT_MS}).catch(() => undefined)

    const current = router.currentRoute.value
    if (current.path === '/login') {
      loggingOut = false
      return
    }

    try {
      const toast = useToast()
      toast.add({
        title: 'Signed out',
        description: 'Your session is no longer valid. Please sign in again.',
        color: 'warning'
      })
    } catch {}

    const redirect = current.fullPath && current.fullPath !== '/' ? `?redirect=${encodeURIComponent(current.fullPath)}` : ''
    await navigateTo(`/login${redirect}`, { replace: true })
    loggingOut = false
  }

  globalThis.$fetch = baseFetch.create({
    onRequest({options}) {
      prepareServerlessRequest(options, session.epoch.value)
    },
    onResponseError({ response, options }) {
      if ((options as typeof options & {workspaceAccountEpoch?: number}).workspaceAccountEpoch !== session.epoch.value) return
      const status = response?.status
      if (status === 401 && router.currentRoute.value.path !== '/login') return logout()
    }
  })
})
