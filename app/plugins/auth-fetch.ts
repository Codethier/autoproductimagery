import {prepareServerlessRequest, SERVERLESS_MUTATION_TIMEOUT_MS} from '../utils/serverlessRequests'

export default defineNuxtPlugin(nuxtApp => {
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
      // Translate when the toast is shown, so it uses the current language.
      const i18n = nuxtApp.$i18n as {t: (key: string) => string}
      toast.add({
        title: i18n.t('account.session.signedOut'),
        description: i18n.t('account.session.expired'),
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
