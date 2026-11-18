<script setup lang="ts">
import GeminiCommonSettings from './GeminiCommonSettings.vue'
import {
  GEMINI_STANDARD_ASPECT_RATIOS,
  type Gemini3ProImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini3ProImageSettings>({required: true})
const {t} = useI18n()
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <label class="text-sm font-medium">{{ t('models.settings.gemini.imageSize') }}
        <select v-model="settings.imageSize" class="setting-input">
          <option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option>
        </select>
        <span class="setting-help">{{ t('models.settings.gemini.imageSizeHelpPro') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.gemini.grounding') }}
        <select v-model="settings.grounding" class="setting-input">
          <option value="off">{{ t('models.settings.options.off') }}</option><option value="web">{{ t('models.settings.options.webSearch') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.gemini.groundingHelpPro') }}</span>
      </label>
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <UCheckbox v-model="settings.includeThoughts" :label="t('models.settings.gemini.includeThoughts')" />
        <p class="setting-help">{{ t('models.settings.gemini.includeThoughtsHelpPro') }}</p>
      </div>
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_STANDARD_ASPECT_RATIOS" />
  </div>
</template>
