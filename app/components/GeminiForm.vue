<script setup lang="ts">
const data = useDataStore()
const prompt = ref('')
const loading = ref(false)
const errorMsg = ref<string | null>(null)

let pastPrompts = useFetch('/api/systemprompts', {deep:true, key: () => 'systemPrompts',})

function clearModels() {
  try {
    // empty array while preserving reactivity
    ;(data.models as any).splice(0)
  } catch { /* no-op */ }
}
function clearInputImages() {
  try {
    ;(data.inputImages as any).splice(0)
  } catch { /* no-op */ }
}

// Elapsed time counter for loading indicator
const elapsedMs = ref(0)
let timerId: any = null
const elapsedLabel = computed(() => {
  const totalSeconds = Math.floor(elapsedMs.value / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})
function startTimer() {
  stopTimer()
  const start = Date.now()
  elapsedMs.value = 0
  timerId = setInterval(() => {
    elapsedMs.value = Date.now() - start
  }, 1000)
}
function stopTimer() {
  if (timerId) {
    clearInterval(timerId)
    timerId = null
  }
}

onBeforeUnmount(() => {
  stopTimer()
})

async function submit() {
  if (loading.value) return
  errorMsg.value = null
  if (data.inputImages.length === 0) {
    errorMsg.value = 'Please select at least one input image.'
    return
  }
  try {
    loading.value = true
    startTimer()
    const res = await $fetch<{ ok: boolean; url?: string; message?: string }>(
        '/api/gemini-normal',
        {
          method: 'POST',
          body: {
            prompt: prompt.value,
            inputImages: data.inputImages,
            modelImages: data.models,
            responseModalities: ['IMAGE']
          }
        }
    )

  } catch (e: any) {
    errorMsg.value = e?.message || 'Request failed'
  } finally {
    await pastPrompts.refresh()
    stopTimer()
    loading.value = false
  }
}

</script>

<template>
  <div>
    <!-- Loading overlay while waiting for Gemini response -->
    <div v-if="loading" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div class="flex flex-col items-center gap-3 p-5 bg-white/90 dark:bg-gray-800/90 rounded-xl shadow-xl">
        <svg class="animate-spin h-7 w-7 text-primary-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <span class="text-sm text-gray-700 dark:text-gray-200">Generating with Gemini…</span>
        <span class="text-xs font-mono text-gray-500 dark:text-gray-400">Elapsed {{ elapsedLabel }}</span>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton color="primary" variant="solid">
          Select Models ({{ data.models.length }})
        </UButton>
        <template #content>
          <Files :is-model-select="true" class="overflow-y-auto"/>
        </template>
      </UModal>
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600 dark:text-gray-300">Selected model image(s)</p>
        <UButton v-if="data.models.length > 0" size="xs" variant="ghost" @click="clearModels">Clear</UButton>
      </div>
      <div v-if="data.models.length > 0" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="m in data.models" :key="m" :src="m" class="w-full object-contain rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"/>
      </div>
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton color="primary" variant="outline">
          Select Input Images ({{ data.inputImages.length }})
        </UButton>
        <template #content>
          <Files :is-image-select="true" class="overflow-y-auto"/>
        </template>
      </UModal>
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600 dark:text-gray-300">Selected input image(s)</p>
        <UButton v-if="data.inputImages.length > 0" size="xs" variant="ghost" @click="clearInputImages">Clear</UButton>
      </div>
      <div v-if="data.inputImages.length > 0" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="i in data.inputImages" :key="i" :src="i" class="w-full object-contain rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"/>
      </div>
      <div class="mt-2">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Prompt</label>
        <UTextarea v-model="prompt" class="w-full" placeholder="Describe how to transform the input image(s)..." autoresize/>
      </div>
      <div class="flex items-center gap-2 justify-end">
        <UButton class="w-full" @click="submit()" :disabled="data.inputImages.length === 0 || loading">
          <span v-if="loading">Submitting...</span>
          <span v-else>Submit</span>
        </UButton>
        <span v-if="errorMsg" class="text-red-500 text-sm">{{ errorMsg }}</span>
      </div>

    </div>
    <div class="mt-6">
      <div v-if="pastPrompts.data?.value?.items?.length" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <system-promp
          v-for="item in pastPrompts.data.value.items"
          :key="item.id"
          :data="item"
        />
      </div>
      <div v-else class="text-sm text-gray-500">No system prompts yet.</div>
    </div>
  </div>
</template>

<style scoped>

</style>