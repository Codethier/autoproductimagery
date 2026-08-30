<script setup lang="ts">
import {
  GEMINI_STANDARD_ASPECT_RATIOS,
  type Gemini25FlashImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini25FlashImageSettings>({required: true})
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      Output is fixed to the model's 1024-class resolution. Thinking and grounding controls are unavailable.
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_STANDARD_ASPECT_RATIOS" />
  </div>
</template>
