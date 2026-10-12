import {subscribeAccountChanges} from '../utils/accountChanges'

export default defineNuxtPlugin(nuxtApp => {
  const session = useAccount()
  const router = useRouter()
  function clearPreviousAccount() {
    session.clear()
    const current = router.currentRoute.value
    if (current.path === '/login') return
    // Image and folder query parameters belong to the previous account.
    const redirect = current.path && current.path !== '/' ? `?redirect=${encodeURIComponent(current.path)}` : ''
    void navigateTo(`/login${redirect}`, {replace: true})
  }
  const stop = subscribeAccountChanges(clearPreviousAccount)
  // Receiving an event never calls logout: the cookie now belongs to the
  // account selected in the other tab, and must not be revoked here.
  nuxtApp.hook('app:beforeMount', () => {
    window.addEventListener('pagehide', event => {if (!event.persisted) stop()})
    window.addEventListener('pageshow', event => {if (event.persisted) clearPreviousAccount()})
  })
  import.meta.hot?.dispose(stop)
})
