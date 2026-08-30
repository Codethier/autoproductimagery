export default defineNuxtRouteMiddleware(async (to) => {
  // Do not guard the login page itself
  if (to.path === '/login') return

  // The session cookie is HttpOnly, so the browser must never inspect it.
  // SSR's request fetch forwards the incoming cookie; browser fetches include
  // same-origin cookies automatically.
  const authenticated = useState<boolean | undefined>('auth-session', () => undefined)
  if (authenticated.value === true) return

  try {
    const requestFetch = useRequestFetch()
    const ok = await requestFetch<boolean>('/api/testCredentials')
    if (ok === true) {
      authenticated.value = true
      return
    }
  } catch {
    authenticated.value = false
  }

  // Any authenticated path returned above.
  const redirect = to.fullPath && to.fullPath !== '/' ? `?redirect=${encodeURIComponent(to.fullPath)}` : ''
  return navigateTo(`/login${redirect}`)
})
