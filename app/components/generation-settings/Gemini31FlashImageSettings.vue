<script setup lang="ts">
import GeminiCommonSettings from './GeminiCommonSettings.vue'
import {
  GEMINI_ALL_ASPECT_RATIOS,
  type Gemini31FlashImageSettings,
} from '~~/schemas/image-generation'

const settings = defineModel<Gemini31FlashImageSettings>({required: true})
const imageSizes = ['512', '1K', '2K', '4K'] as const
const {t} = useI18n()
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <label class="text-sm font-medium">{{ t('models.settings.gemini.imageSize') }}
        <select v-model="settings.imageSize" class="setting-input">
          <option v-for="size in imageSizes" :key="size" :value="size">{{ size }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.gemini.imageSizeHelp31') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.gemini.thinkingLevel') }}
        <select v-model="settings.thinkingLevel" class="setting-input">
          <option value="minimal">{{ t('models.settings.options.minimal') }}</option>
          <option value="high">{{ t('models.settings.options.high') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.gemini.thinkingHelp31') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.gemini.grounding') }}
        <select v-model="settings.grounding" class="setting-input">
          <option value="off">{{ t('models.settings.options.off') }}</option>
          <option value="web">{{ t('models.settings.options.webSearch') }}</option>
          <option value="images">{{ t('models.settings.options.imageSearch') }}</option>
          <option value="web-and-images">{{ t('models.settings.options.webAndImageSearch') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.gemini.groundingHelp31') }}</span>
      </label>
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <UCheckbox v-model="settings.includeThoughts" :label="t('models.settings.gemini.includeThoughts')" />
        <p class="setting-help">{{ t('models.settings.gemini.includeThoughtsHelp') }}</p>
      </div>
    </div>
    <GeminiCommonSettings v-model="settings" :aspect-ratios="GEMINI_ALL_ASPECT_RATIOS" />
  </div>
</template>
