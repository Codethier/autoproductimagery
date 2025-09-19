<script setup lang="ts">
interface SystemPromptItem {
  id: number
  TextPrompt: string
  serverImages: string[]
  modelImages: string[]
  outputImage: string
  createdAt: string
  updatedAt: string
}

interface SystemPromptsResponse {
  ok: boolean
  count: number
  items: SystemPromptItem[]
}

const props = defineProps<{ data?: SystemPromptsResponse }>()
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">Recent System Prompts</h2>
    </div>

    <div v-if="props.data?.items?.length" class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
      <div v-for="item in props.data!.items" :key="item.id" class="border rounded p-2 flex flex-col gap-2">
        <DownloadableImage :src="item.outputImage" :alt="item.TextPrompt" class="w-full aspect-square object-contain rounded" />
        <p class="text-xs line-clamp-2" :title="item.TextPrompt">{{ item.TextPrompt }}</p>
        <div class="flex gap-1 overflow-x-auto">
          <img v-for="m in (item.modelImages || [])" :key="m" :src="m" alt="model" class="h-8 w-8 object-cover rounded border" />
        </div>
      </div>
    </div>
    <div v-else class="text-sm text-gray-500">No system prompts yet.</div>
  </div>
</template>

<style scoped>
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>