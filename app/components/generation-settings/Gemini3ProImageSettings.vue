<script setup lang="ts">
import GeminiCommonSettings from './GeminiCommonSettings.vue'
import {
  GEMINI_STANDARD_ASPECT_RATIOS,
  type Gemini3ProImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini3ProImageSettings>({required: true})
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <label class="text-sm font-medium">Image size
        <select v-model="settings.imageSize" class="setting-input">
          <option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option>
        </select>
        <span class="setting-help">Higher resolutions increase latency and cost.</span>
      </label>
      <label class="text-sm font-medium">Grounding
        <select v-model="settings.grounding" class="setting-input">
          <option value="off">Off</option><option value="web">Web search</option>
        </select>
        <span class="setting-help">This model supports web grounding, not image-search grounding.</span>
      </label>
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <UCheckbox v-model="settings.includeThoughts" label="Include thoughts" />
        <p class="setting-help">Thinking is always enabled; only its returned summary is configurable.</p>
      </div>
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_STANDARD_ASPECT_RATIOS" />
  </div>
</template>
