<script setup lang="ts">
import {IMAGE_MODEL_PROFILES, ImagePathSchema} from '../../schemas/image-generation'
definePageMeta({layout: 'workspace', colorMode: 'dark'})
useHead({title: 'Shared with me · Product Imagery'})
const data = useDataStore()
const account = useAccount()
const initialAccount = {epoch: account.epoch.value, identity: account.identity.value}
const view = ref<'images' | 'people'>('images')
const selectedUrls = ref<string[]>([...data.models])
const referenceLimit = computed(() => Math.max(0, IMAGE_MODEL_PROFILES[data.selectedModel].maxReferenceImages - 1))
const imageTab = ref<HTMLButtonElement>()
const peopleTab = ref<HTMLButtonElement>()
async function switchTab(tab: 'images' | 'people') {
  view.value = tab
  await nextTick()
  ;(tab === 'images' ? imageTab.value : peopleTab.value)?.focus()
}
async function usePeopleReferences(urls: string[]) {
  const references = [...new Set(urls)]
  if (initialAccount.epoch !== account.epoch.value || initialAccount.identity !== account.identity.value
      || references.length > referenceLimit.value || !references.every(url => ImagePathSchema.safeParse(url).success)) return
  data.models = references
  await navigateTo('/edit')
}
watch([account.epoch, account.identity], () => {view.value = 'images'; selectedUrls.value = []}, {flush: 'sync'})
</script>
<template>
  <section class="shared-workspace" aria-label="Shared with me">
    <div class="shared-tabs" role="tablist" aria-label="Shared collections"
         @keydown.right.prevent="switchTab(view === 'images' ? 'people' : 'images')"
         @keydown.left.prevent="switchTab(view === 'images' ? 'people' : 'images')"
         @keydown.home.prevent="switchTab('images')" @keydown.end.prevent="switchTab('people')">
      <button id="shared-images-tab" ref="imageTab" type="button" role="tab" :aria-selected="view === 'images'" aria-controls="shared-image-content" :tabindex="view === 'images' ? 0 : -1" @click="view = 'images'"><UIcon name="i-lucide-images" />Images</button>
      <button id="shared-people-tab" ref="peopleTab" type="button" role="tab" :aria-selected="view === 'people'" aria-controls="shared-people-content" :tabindex="view === 'people' ? 0 : -1" @click="view = 'people'"><UIcon name="i-lucide-contact-round" />People</button>
    </div>
    <div v-if="view === 'images'" id="shared-image-content" role="tabpanel" aria-labelledby="shared-images-tab">
      <AssetBrowser title="Shared with me" initial-scope="shared" shared-only />
    </div>
    <div v-else id="shared-people-content" role="tabpanel" aria-labelledby="shared-people-tab">
      <PeopleBrowser v-model:selected-urls="selectedUrls" :max-selection="referenceLimit" shared-only @confirm="usePeopleReferences" />
    </div>
  </section>
</template>
<style scoped>
.shared-tabs{display:flex;align-items:center;gap:8px;padding:16px 32px;border-bottom:1px solid var(--workspace-border)}.shared-tabs button{display:inline-flex;align-items:center;gap:7px;padding:9px 13px;color:var(--workspace-muted);font-size:11px;border:1px solid transparent;border-radius:8px}.shared-tabs button[aria-selected="true"]{color:var(--workspace-text);border-color:var(--workspace-border);background:var(--workspace-surface)}.shared-tabs button:focus-visible{outline:2px solid var(--workspace-accent);outline-offset:3px}.shared-tabs .iconify{width:14px;height:14px}@media(max-width:600px){.shared-tabs{padding:14px 18px}}
</style>
