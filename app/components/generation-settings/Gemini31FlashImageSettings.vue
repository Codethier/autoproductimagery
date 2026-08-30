<script setup lang="ts">
import {
  GEMINI_ALL_ASPECT_RATIOS,
  type Gemini31FlashImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini31FlashImageSettings>({required: true})
const imageSizes = ['512', '1K', '2K', '4K'] as const
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <label class="text-sm font-medium">Image size
        <select v-model="settings.imageSize" class="setting-input">
          <option v-for="size in imageSizes" :key="size" :value="size">{{ size }}</option>
        </select>
        <span class="setting-help">512 is fastest; 2K/4K increase latency and cost.</span>
      </label>
      <label class="text-sm font-medium">Thinking level
        <select v-model="settings.thinkingLevel" class="setting-input">
          <option value="minimal">Minimal</option>
          <option value="high">High</option>
        </select>
        <span class="setting-help">High can improve complex composition and instruction following.</span>
      </label>
      <label class="text-sm font-medium">Grounding
        <select v-model="settings.grounding" class="setting-input">
          <option value="off">Off</option>
          <option value="web">Web search</option>
          <option value="images">Image search</option>
          <option value="web-and-images">Web + image search</option>
        </select>
        <span class="setting-help">Image search cannot use real-world images of people.</span>
      </label>
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <UCheckbox v-model="settings.includeThoughts" label="Include thoughts" />
        <p class="setting-help">Returns thought summaries when the provider supplies them.</p>
      </div>
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_ALL_ASPECT_RATIOS" />
  </div>
</template>

<style scoped>
.setting-input { display: block; width: 100%; margin-top: .25rem; border: 1px solid rgb(209 213 219); border-radius: .375rem; padding: .5rem .625rem; background: transparent; font-weight: 400; }
.setting-help { display: block; margin-top: .25rem; font-size: .75rem; line-height: 1.25rem; color: rgb(107 114 128); }
:global(.dark) .setting-input { border-color: rgb(55 65 81); }
:global(.dark) .setting-help { color: rgb(156 163 175); }
</style>
