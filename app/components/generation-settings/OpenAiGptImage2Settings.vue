<script setup lang="ts">
import {
  isValidGptImage2Size,
  type OpenAiGptImage2Settings,
} from '~~/schemas/image-generation'

const settings = defineModel<OpenAiGptImage2Settings>({required: true})
const {t} = useI18n()
const sizeValue = computed({
  get: () => settings.value.size ?? '',
  set: (value: string) => { settings.value.size = value.trim() || undefined },
})
const userValue = computed({
  get: () => settings.value.user ?? '',
  set: (value: string) => { settings.value.user = value.trim() || undefined },
})
const compressionDisabled = computed(() => settings.value.outputFormat === 'png')
const sizeError = computed(() => sizeValue.value && !isValidGptImage2Size(sizeValue.value))

watch(() => settings.value.outputFormat, (format) => {
  if (format === 'png') settings.value.outputCompression = undefined
})

function setCompression(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  settings.value.outputCompression = raw === '' ? undefined : Number(raw)
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label class="text-sm font-medium">{{ t('models.settings.openai.customSize') }}
        <input v-model="sizeValue" class="setting-input" :placeholder="t('models.settings.openai.sizePlaceholder')">
        <span class="setting-help">{{ t('models.settings.openai.sizeHelp') }}</span>
        <span v-if="sizeError" class="setting-error">{{ t('models.settings.openai.sizeError', {model: 'GPT Image 2'}) }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.quality') }}
        <select v-model="settings.quality" class="setting-input">
          <option value="auto">{{ t('models.settings.options.auto') }}</option><option value="low">{{ t('models.settings.options.low') }}</option><option value="medium">{{ t('models.settings.options.medium') }}</option><option value="high">{{ t('models.settings.options.high') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.qualityHelp2') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.background') }}
        <select v-model="settings.background" class="setting-input">
          <option value="auto">{{ t('models.settings.options.auto') }}</option><option value="opaque">{{ t('models.settings.options.opaque') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.backgroundHelpOpaqueOnly') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.outputFormat') }}
        <select v-model="settings.outputFormat" class="setting-input">
          <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.outputFormatHelpOpaqueOnly') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.outputCompression') }}
        <input class="setting-input" type="number" min="0" max="100" step="1"
               :disabled="compressionDisabled" :value="settings.outputCompression ?? ''" @input="setCompression">
        <span class="setting-help">{{ t('models.settings.openai.outputCompressionHelp') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.moderation') }}
        <select v-model="settings.moderation" class="setting-input">
          <option value="auto">{{ t('models.settings.options.auto') }}</option><option value="low">{{ t('models.settings.options.moderationLow') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.moderationHelp') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.numberOfImages') }}
        <input v-model.number="settings.numberOfImages" class="setting-input" type="number" min="1" max="10" step="1">
        <span class="setting-help">{{ t('models.settings.openai.numberOfImagesHelp') }}</span>
      </label>
      <label class="text-sm font-medium sm:col-span-2">{{ t('models.settings.openai.endUser') }}
        <input v-model="userValue" class="setting-input" maxlength="256" :placeholder="t('models.settings.openai.endUserPlaceholder')">
        <span class="setting-help">{{ t('models.settings.openai.endUserHelp') }}</span>
      </label>
    </div>
    <div class="rounded-lg border border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
      {{ t('models.settings.openai.note2') }}
    </div>
  </div>
</template>
