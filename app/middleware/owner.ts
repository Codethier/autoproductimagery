export default defineNuxtRouteMiddleware(() => {
  if (!useAccount().isOwner.value) return navigateTo('/assets')
})
