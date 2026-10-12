export default defineNuxtRouteMiddleware(async (to) => {
  // Do not guard the login page itself
  if (to.path === '/login') return

  // The session cookie is HttpOnly, so the browser must never inspect it.
  // SSR's request fetch forwards the incoming cookie; browser fetches include
  // same-origin cookies automatically.
  const session = useAccount()
  if (session.account.value) return

  try {
    if (await session.load()) return
  } catch {
    session.clear()
  }

  // Any authenticated path returned above.
  const redirect = to.fullPath && to.fullPath !== '/' ? `?redirect=${encodeURIComponent(to.fullPath)}` : ''
  return navigateTo(`/login${redirect}`)
})
