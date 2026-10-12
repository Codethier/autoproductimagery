<script setup lang="ts">
const route = useRoute()
const session = useAccount()
const navigationOpen = ref(false)
const accountOpen = ref(false)
const signingOut = ref(false)
provide('workspace-account-identity', session.identity)
const nav = computed(() => [
  {to: '/edit', label: 'Edit', icon: 'i-lucide-pencil-ruler'},
  {to: '/same-origin-batch', label: 'Same-origin batch', icon: 'i-lucide-copy-plus'},
  {to: '/assets', label: 'Library', icon: 'i-lucide-images'},
  {to: '/shared', label: 'Shared with me', icon: 'i-lucide-users-round'},
  ...(session.isOwner.value ? [{to: '/team', label: 'Team', icon: 'i-lucide-user-round-cog'}] : []),
])
const initials = computed(() => (session.account.value?.displayName || session.account.value?.username || '?').split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase())
watch(() => route.path, () => { navigationOpen.value = false; accountOpen.value = false })
async function signOut() {
  if (signingOut.value) return
  signingOut.value = true
  try { await session.signOut() }
  finally { signingOut.value = false }
}
</script>

<template>
  <div class="imagery-workspace">
    <a class="workspace-skip" href="#workspace-content">Skip to workspace</a>
    <header class="workspace-header">
      <NuxtLink to="/edit" class="workspace-brand" aria-label="Product imagery studio">
        <span class="workspace-brand-mark"><UIcon name="i-lucide-aperture" /></span>
        <span><strong>Product imagery</strong><small>{{ session.account.value?.organizationName || 'Studio' }}</small></span>
      </NuxtLink>
      <button class="workspace-mobile-toggle workspace-icon-button" type="button" :aria-expanded="navigationOpen" aria-controls="workspace-navigation" aria-label="Toggle navigation" @click="navigationOpen = !navigationOpen"><UIcon :name="navigationOpen ? 'i-lucide-x' : 'i-lucide-menu'" /></button>
      <nav id="workspace-navigation" class="workspace-navigation" :class="{'is-open': navigationOpen}" aria-label="Main navigation">
        <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" class="workspace-nav-link" :class="{'is-active': route.path === item.to}" :aria-current="route.path === item.to ? 'page' : undefined"><UIcon :name="item.icon" /><span>{{ item.label }}</span></NuxtLink>
      </nav>
      <div class="workspace-account">
        <button class="workspace-account-toggle" type="button" :aria-expanded="accountOpen" aria-controls="workspace-account-menu" aria-label="Account menu" @click="accountOpen = !accountOpen"><span class="workspace-avatar">{{ initials }}</span><span class="workspace-account-name">{{ session.account.value?.displayName || session.account.value?.username }}</span><UIcon name="i-lucide-chevron-down" /></button>
        <div v-if="accountOpen" id="workspace-account-menu" class="workspace-account-menu" @keydown.esc="accountOpen = false">
          <span>{{ session.account.value?.username }} · {{ session.isOwner.value ? 'Organization owner' : 'Member' }}</span>
          <NuxtLink to="/account"><UIcon name="i-lucide-key-round" />Password & account</NuxtLink>
          <button type="button" :disabled="signingOut" @click="signOut"><UIcon name="i-lucide-log-out" />{{ signingOut ? 'Signing out…' : 'Sign out' }}</button>
        </div>
      </div>
    </header>
    <main id="workspace-content" class="workspace-main" tabindex="-1"><slot /></main>
  </div>
</template>
