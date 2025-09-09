export default defineNuxtRouteMiddleware((to) => {
  // Do not guard the login page itself
  if (to.path === '/login') return

  // Check for auth cookie
  const auth = useCookie<string | null>('auth')

  if (!auth.value) {
    // Preserve intended destination
    const redirect = to.fullPath && to.fullPath !== '/' ? `?redirect=${encodeURIComponent(to.fullPath)}` : ''
    return navigateTo(`/login${redirect}`)
  }
})