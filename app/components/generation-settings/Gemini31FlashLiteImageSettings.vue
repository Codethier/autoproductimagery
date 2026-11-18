<script setup lang="ts">
import GeminiCommonSettings from './GeminiCommonSettings.vue'
import {
  GEMINI_ALL_ASPECT_RATIOS,
  type Gemini31FlashLiteImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini31FlashLiteImageSettings>({required: true})
const {t} = useI18n()
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <label class="text-sm font-medium">{{ t('models.settings.gemini.imageSize') }}
        <select v-model="settings.imageSize" class="setting-input" disabled><option value="1K">1K</option></select>
        <span class="setting-help">{{ t('models.settings.gemini.imageSizeHelpFixed') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.gemini.thinkingLevel') }}
        <select v-model="settings.thinkingLevel" class="setting-input">
          <option value="minimal">{{ t('models.settings.options.minimal') }}</option><option value="high">{{ t('models.settings.options.high') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.gemini.thinkingHelpLite') }}</span>
      </label>
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <UCheckbox v-model="settings.includeThoughts" :label="t('models.settings.gemini.includeThoughts')" />
        <p class="setting-help">{{ t('models.settings.gemini.groundingUnavailableLite') }}</p>
      </div>
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_ALL_ASPECT_RATIOS" :max-output-tokens="4096" />
  </div>
</template>
