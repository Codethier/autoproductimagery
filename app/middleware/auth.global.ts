import {fetchStatusCode} from '../utils/serverlessRequests'

export default defineNuxtRouteMiddleware(async (to) => {
  // Do not guard the login page itself
  if (to.path === '/login') return

  // The session cookie is HttpOnly, so the browser must never inspect it.
  // SSR's request fetch forwards the incoming cookie; browser fetches include
  // same-origin cookies automatically.
  const session = useAccount()
  if (session.account.value) return
  const epoch = session.epoch.value
  const redirect = to.fullPath && to.fullPath !== '/' ? `?redirect=${encodeURIComponent(to.fullPath)}` : ''

  try {
    if (await session.load()) return
  } catch (error) {
    if (epoch !== session.epoch.value) return abortNavigation()
    if (fetchStatusCode(error) === 401) {
      session.clear()
      return navigateTo(`/login${redirect}`)
    }
    throw createError({statusCode: 503, statusMessage: 'The workspace is starting. Please try again shortly.', data: {workspaceWarmup: true, retryPath: to.fullPath}})
  }
  if (epoch !== session.epoch.value) return abortNavigation()

  // Any authenticated path returned above.
  return navigateTo(`/login${redirect}`)
})
