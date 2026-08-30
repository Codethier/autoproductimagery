<script setup lang="ts">
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

<style scoped>
.setting-input { display:block; width:100%; margin-top:.25rem; border:1px solid rgb(209 213 219); border-radius:.375rem; padding:.5rem .625rem; background:transparent; font-weight:400; }
.setting-help { display:block; margin-top:.25rem; font-size:.75rem; line-height:1.25rem; color:rgb(107 114 128); }
:global(.dark) .setting-input { border-color:rgb(55 65 81); } :global(.dark) .setting-help { color:rgb(156 163 175); }
</style>
