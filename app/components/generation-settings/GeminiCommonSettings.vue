<script setup lang="ts">
import {
  minimumGeminiImageTokens,
  type GeminiAspectRatio,
  type GeminiImageGenerationSettings,
  type GeminiSafetySettings,
} from '~~/schemas/image-generation'

const props = withDefaults(defineProps<{
  aspectRatios: readonly GeminiAspectRatio[]
  maxOutputTokens?: number
}>(), {
  maxOutputTokens: 32768,
})

const settings = defineModel<GeminiImageGenerationSettings>({required: true})
const minimumOutputTokens = computed(() => minimumGeminiImageTokens(
  settings.value,
) ?? 1)
const {t, locale} = useI18n()
// Labels are message keys, translated at render time so a language switch applies.
const safetyOptions = [
  {labelKey: 'off', value: 'OFF'},
  {labelKey: 'blockNone', value: 'BLOCK_NONE'},
  {labelKey: 'blockOnlyHigh', value: 'BLOCK_ONLY_HIGH'},
  {labelKey: 'blockMediumAndAbove', value: 'BLOCK_MEDIUM_AND_ABOVE'},
  {labelKey: 'blockLowAndAbove', value: 'BLOCK_LOW_AND_ABOVE'},
] as const
const safetyFields: ReadonlyArray<keyof GeminiSafetySettings> = ['hateSpeech', 'dangerousContent', 'harassment', 'sexuallyExplicit']

function setOptionalNumber(key: keyof GeminiImageGenerationSettings['sampling'], event: Event) {
  const raw = (event.target as HTMLInputElement).value
  settings.value.sampling[key] = raw === '' ? undefined : Number(raw)
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label class="setting-label">{{ t('models.settings.gemini.aspectRatio') }}</label>
        <select v-model="settings.aspectRatio" class="setting-input">
          <option :value="undefined">{{ t('models.settings.gemini.aspectRatioDefault') }}</option>
          <option v-for="ratio in props.aspectRatios" :key="ratio" :value="ratio">{{ ratio }}</option>
        </select>
        <p class="setting-help">{{ t('models.settings.gemini.aspectRatioHelp') }}</p>
      </div>
      <div class="setting-card">
        <UCheckbox v-model="settings.includeText" :label="t('models.settings.gemini.includeText')" />
        <p class="setting-help">{{ t('models.settings.gemini.includeTextHelp') }}</p>
      </div>
    </div>

    <details class="setting-section">
      <summary class="cursor-pointer text-sm font-semibold">{{ t('models.settings.gemini.sampling') }}</summary>
      <p class="setting-help mt-1">{{ t('models.settings.gemini.samplingHelp') }}</p>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label class="setting-label">{{ t('models.settings.gemini.temperature') }}
          <input class="setting-input" type="number" min="0" max="2" step="0.01"
                 :value="settings.sampling.temperature ?? ''" @input="setOptionalNumber('temperature', $event)">
          <span class="setting-help">{{ t('models.settings.gemini.temperatureHelp') }}</span>
        </label>
        <label class="setting-label">{{ t('models.settings.gemini.topP') }}
          <input class="setting-input" type="number" min="0" max="1" step="0.01"
                 :value="settings.sampling.topP ?? ''" @input="setOptionalNumber('topP', $event)">
          <span class="setting-help">{{ t('models.settings.gemini.topPHelp') }}</span>
        </label>
        <label class="setting-label">{{ t('models.settings.gemini.topK') }}
          <input class="setting-input" type="number" min="1" max="1000" step="1"
                 :value="settings.sampling.topK ?? ''" @input="setOptionalNumber('topK', $event)">
          <span class="setting-help">{{ t('models.settings.gemini.topKHelp') }}</span>
        </label>
        <label class="setting-label">{{ t('models.settings.gemini.seed') }}
          <input class="setting-input" type="number" min="-2147483648" max="2147483647" step="1"
                 :value="settings.sampling.seed ?? ''" @input="setOptionalNumber('seed', $event)">
          <span class="setting-help">{{ t('models.settings.gemini.seedHelp') }}</span>
        </label>
        <label class="setting-label">{{ t('models.settings.gemini.maxOutputTokens') }}
          <input class="setting-input" type="number" :min="minimumOutputTokens" :max="props.maxOutputTokens" step="1"
                 :value="settings.sampling.maxOutputTokens ?? ''" @input="setOptionalNumber('maxOutputTokens', $event)">
          <span class="setting-help">{{ t('models.settings.gemini.maxOutputTokensHelp', {min: minimumOutputTokens.toLocaleString(locale), max: props.maxOutputTokens.toLocaleString(locale)}) }}</span>
        </label>
      </div>
    </details>

    <details class="setting-section">
      <summary class="cursor-pointer text-sm font-semibold">{{ t('models.settings.gemini.safety') }}</summary>
      <p class="setting-help mt-1">{{ t('models.settings.gemini.safetyHelp') }}</p>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label v-for="field in safetyFields" :key="field" class="setting-label">
          {{ t(`models.settings.gemini.safetyFields.${field}`) }}
          <select v-model="settings.safety[field]" class="setting-input">
            <option v-for="option in safetyOptions" :key="option.value" :value="option.value">{{ t(`models.settings.gemini.safetyOptions.${option.labelKey}`) }}</option>
          </select>
        </label>
      </div>
    </details>
  </div>
</template>
