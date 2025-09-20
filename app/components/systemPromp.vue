<script setup lang="ts">
import type { SystemPrompt } from '~/server/db/schema'

const props = defineProps<{ data: SystemPrompt }>()

const createdAt = computed(() => {
  const d = props.data?.createdAt ? new Date(props.data.createdAt) : null
  return d ? d.toLocaleString() : ''
})
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

    <div class="p-3 flex flex-col gap-3">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-3" :title="props.data?.TextPrompt">
        {{ props.data?.TextPrompt }}
      </p>

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

      <div class="flex items-center justify-end">
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