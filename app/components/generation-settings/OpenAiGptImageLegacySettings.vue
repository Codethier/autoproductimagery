<script setup lang="ts">
import {
  GPT_IMAGE_LEGACY_SIZES,
  type OpenAiGptImageLegacySettings,
} from '~~/schemas/image-generation'

const settings = defineModel<OpenAiGptImageLegacySettings>({required: true})
const {t} = useI18n()
const userValue = computed({
  get: () => settings.value.user ?? '',
  set: (value: string) => { settings.value.user = value.trim() || undefined },
})
const compressionDisabled = computed(() => settings.value.outputFormat === 'png')
function setSize(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  settings.value.size = GPT_IMAGE_LEGACY_SIZES.find(size => size === value)
}

watch(() => settings.value.outputFormat, (format) => {
  if (format === 'png') settings.value.outputCompression = undefined
})

watch(() => settings.value.background, (background) => {
  if (background === 'transparent' && settings.value.outputFormat === 'jpeg') {
    settings.value.outputFormat = 'png'
    settings.value.outputCompression = undefined
  }
}, {flush: 'sync'})

function setCompression(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  settings.value.outputCompression = raw === '' ? undefined : Number(raw)
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label class="text-sm font-medium">{{ t('models.settings.openai.outputSize') }}
        <select :value="settings.size ?? ''" class="setting-input" @change="setSize">
          <option value="">{{ t('models.settings.modelDefault') }}</option>
          <option v-for="size in GPT_IMAGE_LEGACY_SIZES" :key="size" :value="size">{{ size }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.outputSizeHelp') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.quality') }}
        <select v-model="settings.quality" class="setting-input">
          <option value="auto">{{ t('models.settings.options.auto') }}</option><option value="low">{{ t('models.settings.options.low') }}</option><option value="medium">{{ t('models.settings.options.medium') }}</option><option value="high">{{ t('models.settings.options.high') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.qualityHelpLegacy') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.background') }}
        <select v-model="settings.background" class="setting-input">
          <option value="auto">{{ t('models.settings.options.auto') }}</option><option value="opaque">{{ t('models.settings.options.opaque') }}</option><option value="transparent">{{ t('models.settings.options.transparent') }}</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.backgroundHelp') }}</span>
      </label>
      <label class="text-sm font-medium">{{ t('models.settings.openai.outputFormat') }}
        <select v-model="settings.outputFormat" class="setting-input">
          <option value="png">PNG</option><option value="jpeg" :disabled="settings.background === 'transparent'">JPEG</option><option value="webp">WebP</option>
        </select>
        <span class="setting-help">{{ t('models.settings.openai.outputFormatHelp') }}</span>
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
      {{ t('models.settings.openai.noteLegacy') }}
    </div>
  </div>
</template>
