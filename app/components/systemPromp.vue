<script setup lang="ts">
import type { SystemPrompt } from '~/server/db/schema'
import { refreshNuxtData } from '#app'

const props = defineProps<{ data: SystemPrompt }>()

const createdAt = computed(() => {
  const d = props.data?.createdAt ? new Date(props.data.createdAt) : null
  return d ? d.toLocaleString() : ''
})

const regenLoading = ref(false)
const regenCount = ref<number>(1)
const toast = useToast()

async function regenerate() {
  if (regenLoading.value) return
  try {
    regenLoading.value = true
    const inputImages = Array.isArray(props.data?.serverImages) ? props.data.serverImages : []
    const modelImages = Array.isArray(props.data?.modelImages) ? props.data.modelImages : []

    if (inputImages.length === 0) {
      toast.add({ title: 'Cannot regenerate', description: 'No input images stored for this item.', color: 'warning' })
      return
    }

    // Ask the user to edit/confirm the prompt before regenerating
    const currentPrompt = props.data?.TextPrompt || ''
    const editedPrompt = typeof window !== 'undefined' ? window.prompt('Edit prompt before regenerating:', currentPrompt) : currentPrompt
    if (editedPrompt === null) {
      // User cancelled
      return
    }

    const count = Math.max(1, Math.min(50, Number(regenCount.value) || 1))

    // Run the job count times
    for (let i = 0; i < count; i++) {
      await $fetch('/api/gemini-normal', {
        method: 'POST',
        body: {
          prompt: editedPrompt,
          inputImages,
          modelImages,
          responseModalities: ['IMAGE']
        }
      })
    }

    toast.add({ title: 'Regeneration started', description: `Created ${count} job${count > 1 ? 's' : ''}.` })
  } catch (e: any) {
    console.error(e)
    toast.add({ title: 'Regeneration failed', color: 'warning' })
  } finally {
    await refreshNuxtData('systemPrompts')
    regenLoading.value = false
  }
}
</script>

<template>
  <div
    class="group relative overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/50 shadow-sm hover:shadow-lg transition-all duration-200"
  >
    <div v-if="props.data?.outputImage" class="relative">
      <DownloadableImage
        :src="props.data.outputImage"
        :alt="props.data?.TextPrompt || 'Output image'"
        class="w-full h-auto object-contain bg-gray-50 dark:bg-gray-800"
      />
      <span class="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-medium rounded bg-white/80 dark:bg-gray-900/70 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-700">
        Output
      </span>
    </div>
    <div v-else class="relative flex items-center gap-2 justify-center p-6 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-b border-red-200 dark:border-red-800">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.721-1.36 3.486 0l6.518 11.58c.75 1.333-.213 2.996-1.742 2.996H3.48c-1.53 0-2.492-1.663-1.743-2.996L8.257 3.1zM11 14a1 1 0 10-2 0 1 1 0 002 0zm-1-2a.75.75 0 01-.75-.75v-3.5a.75.75 0 011.5 0v3.5A.75.75 0 0110 12z" clip-rule="evenodd" />
      </svg>
      <span class="text-sm font-medium">No output image</span>
    </div>

    <div class="p-3 flex flex-col gap-3">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-3" :title="props.data?.TextPrompt">
        {{ props.data?.TextPrompt }}
      </p>

      <div v-if="props.data?.errors" class="flex items-start gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded border border-red-200 dark:border-red-800">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mt-0.5">
          <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.721-1.36 3.486 0l6.518 11.58c.75 1.333-.213 2.996-1.742 2.996H3.48c-1.53 0-2.492-1.663-1.743-2.996L8.257 3.1zM11 14a1 1 0 10-2 0 1 1 0 002 0zm-1-2a.75.75 0 01-.75-.75v-3.5a.75.75 0 011.5 0v3.5A.75.75 0 0110 12z" clip-rule="evenodd" />
        </svg>
        <span class="whitespace-pre-line">{{ props.data.errors }}</span>
      </div>

      <div v-if="props.data?.serverImages?.length" class="mt-1">
        <div class="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Input image(s)</div>
        <div class="grid grid-cols-5 gap-1">
          <DownloadableImage
            v-for="s in props.data.serverImages"
            :key="s"
            :src="s"
            :alt="'Input ' + s"
            class="h-16 w-full object-cover rounded bg-gray-50 dark:bg-gray-800"
          />
        </div>
      </div>

      <div v-if="props.data?.modelImages?.length" class="mt-1">
        <div class="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Model image(s)</div>
        <div class="grid grid-cols-5 gap-1">
          <DownloadableImage
            v-for="m in props.data.modelImages"
            :key="m"
            :src="m"
            :alt="'Model ' + m"
            class="h-16 w-full object-cover rounded bg-gray-50 dark:bg-gray-800"
          />
        </div>
      </div>

      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UButton size="xs" :loading="regenLoading" :disabled="regenLoading || !(props.data?.serverImages?.length)" @click="regenerate">
            Regenerate
          </UButton>
          <div class="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <span>×</span>
            <UInput v-model.number="regenCount" type="number" size="xs" class="w-14" :ui="{ size: { xs: 'text-xs' } }" min="1" :disabled="regenLoading" />
            <span>times</span>
          </div>
        </div>
        <span class="text-[11px] text-gray-500 dark:text-gray-400">{{ createdAt }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>