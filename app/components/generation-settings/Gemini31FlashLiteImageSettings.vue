<script setup lang="ts">
import GeminiCommonSettings from './GeminiCommonSettings.vue'
import {
  GEMINI_ALL_ASPECT_RATIOS,
  type Gemini31FlashLiteImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini31FlashLiteImageSettings>({required: true})
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <label class="text-sm font-medium">Image size
        <select v-model="settings.imageSize" class="setting-input" disabled><option value="1K">1K</option></select>
        <span class="setting-help">Fixed by the model; other sizes are unavailable.</span>
      </label>
      <label class="text-sm font-medium">Thinking level
        <select v-model="settings.thinkingLevel" class="setting-input">
          <option value="minimal">Minimal</option><option value="high">High</option>
        </select>
        <span class="setting-help">High trades additional latency for more planning.</span>
      </label>
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <UCheckbox v-model="settings.includeThoughts" label="Include thoughts" />
        <p class="setting-help">Grounding is unavailable on Flash Lite.</p>
      </div>
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_ALL_ASPECT_RATIOS" :max-output-tokens="4096" />
  </div>
</template>
