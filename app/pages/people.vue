<script setup lang="ts">
import {IMAGE_MODEL_PROFILES, ImagePathSchema} from '../../schemas/image-generation'
definePageMeta({layout: 'workspace', colorMode: 'dark'})
useHead({title: 'People · Product Imagery'})
const data = useDataStore()
const account = useAccount()
const initialAccount = {epoch: account.epoch.value, identity: account.identity.value}
const selectedUrls = ref<string[]>([...data.models])
const referenceLimit = computed(() => Math.max(0, IMAGE_MODEL_PROFILES[data.selectedModel].maxReferenceImages - 1))
async function useReferences(urls: string[]) {
  const references = [...new Set(urls)]
  if (initialAccount.epoch !== account.epoch.value || initialAccount.identity !== account.identity.value || references.length > referenceLimit.value || !references.every(url => ImagePathSchema.safeParse(url).success)) return
  data.models = references
  await navigateTo('/edit')
}
watch(account.epoch, () => { selectedUrls.value = [] }, {flush: 'sync'})
</script>

<template>
  <PeopleBrowser v-model:selected-urls="selectedUrls" :max-selection="referenceLimit" @confirm="useReferences" />
</template>
