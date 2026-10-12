<script setup lang="ts">
const route = useRoute()
const navigationOpen = ref(false)
const signingOut = ref(false)
const nav = [
  {to: '/edit', label: 'Edit', icon: 'i-lucide-sliders-horizontal', description: 'Work with one image'},
  {to: '/same-origin-batch', label: 'Same-origin batch', icon: 'i-lucide-layers', description: 'One prompt, multiple images'},
  {to: '/assets', label: 'Assets', icon: 'i-lucide-folder-open', description: 'Your image library'},
]
watch(() => route.path, () => { navigationOpen.value = false })
async function signOut() {
  if (signingOut.value) return
  signingOut.value = true
  try {
    await $fetch('/api/logout', {method: 'POST'})
    useState<boolean | undefined>('auth-session', () => undefined).value = false
    await navigateTo('/login')
  } finally { signingOut.value = false }
}
</script>

<template>
  <div class="imagery-workspace">
    <a class="workspace-skip" href="#workspace-content">Skip to workspace</a>
    <button class="workspace-mobile-toggle workspace-icon-button" type="button"
            :aria-expanded="navigationOpen" aria-controls="workspace-navigation" aria-label="Toggle navigation"
            @click="navigationOpen = !navigationOpen">
      <UIcon :name="navigationOpen ? 'i-lucide-x' : 'i-lucide-menu'" />
    </button>
    <button v-if="navigationOpen" class="workspace-navigation-scrim" aria-label="Close navigation"
            @click="navigationOpen = false" />
    <aside id="workspace-navigation" class="workspace-navigation" :class="{'is-open': navigationOpen}">
      <NuxtLink to="/edit" class="workspace-brand" aria-label="Product imagery workspace">
        <span class="workspace-brand-mark"><UIcon name="i-lucide-scan" /></span>
        <span><strong>Product imagery</strong><small>Personal workspace</small></span>
      </NuxtLink>
      <div class="workspace-nav-section">Workspace</div>
      <nav aria-label="Main navigation">
        <NuxtLink v-for="item in nav" :key="item.to" :to="item.to"
                  class="workspace-nav-link" :class="{'is-active': route.path === item.to}"
                  :aria-current="route.path === item.to ? 'page' : undefined" :title="item.description">
          <UIcon :name="item.icon" /><span>{{ item.label }}</span>
        </NuxtLink>
      </nav>
      <div class="workspace-sidebar-note">
        <span class="workspace-note-icon"><UIcon name="i-lucide-sparkles" /></span>
        <strong>Your products. A new perspective.</strong>
        <p>Edit a single image, or give a collection the same creative direction.</p>
      </div>
      <div class="workspace-nav-footer">
        <span class="workspace-private"><UIcon name="i-lucide-lock-keyhole" /> Private image library</span>
        <button type="button" class="workspace-nav-link" :disabled="signingOut" @click="signOut">
          <UIcon name="i-lucide-log-out" /><span>{{ signingOut ? 'Signing out…' : 'Sign out' }}</span>
        </button>
      </div>
    </aside>
    <main id="workspace-content" class="workspace-main" tabindex="-1"><slot /></main>
  </div>
</template>
