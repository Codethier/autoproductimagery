<script setup lang="ts">
import {formatBalanceUsd, formatUsd} from '../utils/generationPrice'
const route = useRoute()
const {t} = useI18n()
const session = useAccount()
const accountBalance = useAccountBalance()
const data = useDataStore()
const peopleGenerationProgress = usePeopleGenerationProgress()
const navigationOpen = ref(false)
const accountOpen = ref(false)
const signingOut = ref(false)
provide('workspace-account-identity', session.identity)
const nav = computed(() => [
  {to: '/edit', label: t('common.layout.nav.edit'), icon: 'i-lucide-pencil-ruler'},
  {to: '/same-origin-batch', label: t('common.layout.nav.sameOriginBatch'), icon: 'i-lucide-copy-plus'},
  {to: '/pipelines', label: t('common.layout.nav.pipelines'), icon: 'i-lucide-workflow'},
  {to: '/people', label: t('common.layout.nav.people'), icon: 'i-lucide-contact-round'},
  {to: '/assets', label: t('common.layout.nav.library'), icon: 'i-lucide-images'},
  {to: '/shared', label: t('common.layout.nav.shared'), icon: 'i-lucide-users-round'},
  ...(session.isOwner.value ? [{to: '/team', label: t('common.layout.nav.team'), icon: 'i-lucide-user-round-cog'}] : []),
])
const initials = computed(() => (session.account.value?.displayName || session.account.value?.username || '?').split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase())
watch(() => route.path, () => { navigationOpen.value = false; accountOpen.value = false })
let balancePollAttempts = 0
watch(() => data.pendingGenerations.length + peopleGenerationProgress.count.value, () => { balancePollAttempts = 0; void accountBalance.refresh() })
watch(session.epoch, () => { accountOpen.value = false; balancePollAttempts = 0; void accountBalance.refresh() })
let balanceTimer: ReturnType<typeof setInterval> | undefined
onServerPrefetch(() => accountBalance.refresh())
onMounted(() => {
  void accountBalance.refresh()
  balanceTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && balancePollAttempts < 30 && (data.pendingGenerations.length || peopleGenerationProgress.count.value || accountBalance.balance.value?.outstandingCount)) { balancePollAttempts += 1; void accountBalance.refresh() }
  }, 10_000)
})
onBeforeUnmount(() => { if (balanceTimer) clearInterval(balanceTimer) })
async function signOut() {
  if (signingOut.value) return
  signingOut.value = true
  try { await session.signOut() }
  finally { signingOut.value = false }
}
</script>

<template>
  <div class="imagery-workspace">
    <a class="workspace-skip" href="#workspace-content">{{ t('common.layout.skipToWorkspace') }}</a>
    <header class="workspace-header">
      <NuxtLink to="/edit" class="workspace-brand" :aria-label="t('common.layout.brandLabel')">
        <span class="workspace-brand-mark"><UIcon name="i-lucide-aperture" /></span>
        <span><strong>{{ t('common.appName') }}</strong><small>{{ session.account.value?.organizationName || t('common.layout.studio') }}</small></span>
      </NuxtLink>
      <button class="workspace-mobile-toggle workspace-icon-button" type="button" :aria-expanded="navigationOpen" aria-controls="workspace-navigation" :aria-label="t('common.layout.toggleNavigation')" @click="navigationOpen = !navigationOpen"><UIcon :name="navigationOpen ? 'i-lucide-x' : 'i-lucide-menu'" /></button>
      <nav id="workspace-navigation" class="workspace-navigation" :class="{'is-open': navigationOpen}" :aria-label="t('common.layout.mainNavigation')">
        <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" class="workspace-nav-link" :class="{'is-active': route.path === item.to}" :aria-current="route.path === item.to ? 'page' : undefined"><UIcon :name="item.icon" /><span>{{ item.label }}</span></NuxtLink>
      </nav>
      <div class="workspace-account">
        <NuxtLink to="/account" class="workspace-balance-chip" :aria-label="t('common.layout.viewBalance')"><UIcon name="i-lucide-wallet" /><span>{{ accountBalance.balance.value ? accountBalance.balance.value.unlimited ? t('common.layout.unlimited') : formatBalanceUsd(accountBalance.balance.value.actualBalanceUsd) : t('common.layout.balance') }}</span></NuxtLink>
        <button class="workspace-account-toggle" type="button" :aria-expanded="accountOpen" aria-controls="workspace-account-menu" :aria-label="t('common.layout.accountMenu')" @click="accountOpen = !accountOpen"><span class="workspace-avatar">{{ initials }}</span><span class="workspace-account-name">{{ session.account.value?.displayName || session.account.value?.username }}</span><UIcon name="i-lucide-chevron-down" /></button>
        <div v-if="accountOpen" id="workspace-account-menu" class="workspace-account-menu" @keydown.esc="accountOpen = false">
          <span>{{ session.account.value?.username }} · {{ session.isOwner.value ? t('common.layout.organizationOwner') : t('common.layout.member') }}</span>
          <div v-if="accountBalance.balance.value" class="workspace-balance-menu"><span>{{ t('common.layout.actualBalance') }}<strong>{{ accountBalance.balance.value.unlimited ? t('common.layout.unlimited') : formatBalanceUsd(accountBalance.balance.value.actualBalanceUsd) }}</strong></span><span>{{ t('common.layout.outstanding') }}<strong>{{ formatUsd(accountBalance.balance.value.outstandingEstimateUsd) }}{{ accountBalance.balance.value.outstandingUnknownCount ? t('common.layout.unpricedSuffix') : '' }}</strong></span><small>{{ t('common.layout.awaitingFinalPrice', {count: accountBalance.balance.value.outstandingCount}) }}</small></div>
          <NuxtLink to="/account"><UIcon name="i-lucide-key-round" />{{ t('common.layout.passwordAndAccount') }}</NuxtLink>
          <LanguageSwitcher class="workspace-menu-language" />
          <button type="button" :disabled="signingOut" @click="signOut"><UIcon name="i-lucide-log-out" />{{ signingOut ? t('common.layout.signingOut') : t('common.layout.signOut') }}</button>
        </div>
      </div>
    </header>
    <main id="workspace-content" class="workspace-main" tabindex="-1"><slot /></main>
    <GenerationCreditDialog />
  </div>
</template>

<style scoped>
.workspace-account{display:flex;align-items:center;gap:18px}.workspace-balance-chip{display:flex;align-items:center;gap:7px;white-space:nowrap;font-size:10px;color:#dfc3a0;border:1px solid var(--workspace-border);border-radius:999px;padding:7px 9px}.workspace-balance-chip .iconify{width:12px;height:12px}.workspace-balance-menu{padding:8px 9px 15px;border-bottom:1px solid var(--workspace-border);margin-bottom:5px}.workspace-balance-menu>span{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:10px;color:var(--workspace-muted);margin-bottom:9px}.workspace-balance-menu strong{font-size:11px;color:#e8c7a2;font-weight:500;overflow-wrap:anywhere}.workspace-menu-language{padding:8px 9px}.workspace-balance-menu small{font-size:9px;color:var(--workspace-muted)}@media(max-width:1100px){.workspace-account{gap:9px}}@media(max-width:760px){.workspace-balance-chip{font-size:9px;padding:6px}.workspace-balance-chip .iconify{display:none}}
</style>
