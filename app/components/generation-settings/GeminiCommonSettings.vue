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
const safetyOptions = [
  {label: 'Off', value: 'OFF'},
  {label: 'Block none', value: 'BLOCK_NONE'},
  {label: 'Block high only', value: 'BLOCK_ONLY_HIGH'},
  {label: 'Block medium and above', value: 'BLOCK_MEDIUM_AND_ABOVE'},
  {label: 'Block low and above', value: 'BLOCK_LOW_AND_ABOVE'},
]
const safetyFields: Array<{key: keyof GeminiSafetySettings; label: string}> = [
  {key: 'hateSpeech', label: 'Hate speech'},
  {key: 'dangerousContent', label: 'Dangerous content'},
  {key: 'harassment', label: 'Harassment'},
  {key: 'sexuallyExplicit', label: 'Sexually explicit'},
]

function setOptionalNumber(key: keyof GeminiImageGenerationSettings['sampling'], event: Event) {
  const raw = (event.target as HTMLInputElement).value
  settings.value.sampling[key] = raw === '' ? undefined : Number(raw)
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label class="setting-label">Aspect ratio</label>
        <select v-model="settings.aspectRatio" class="setting-input">
          <option :value="undefined">Default (model decides)</option>
          <option v-for="ratio in props.aspectRatios" :key="ratio" :value="ratio">{{ ratio }}</option>
        </select>
        <p class="setting-help">Default matches the first reference image's ratio, or uses 1:1 without a reference.</p>
      </div>
      <div class="setting-card">
        <UCheckbox v-model="settings.includeText" label="Return model text with the image" />
        <p class="setting-help">Stores any explanatory text returned alongside the generated image.</p>
      </div>
    </div>

    <details class="setting-section">
      <summary class="cursor-pointer text-sm font-semibold">Sampling controls</summary>
      <p class="setting-help mt-1">Optional advanced controls. Blank values use the provider defaults.</p>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label class="setting-label">Temperature
          <input class="setting-input" type="number" min="0" max="2" step="0.01"
                 :value="settings.sampling.temperature ?? ''" @input="setOptionalNumber('temperature', $event)">
        </label>
        <label class="setting-label">Top P
          <input class="setting-input" type="number" min="0" max="1" step="0.01"
                 :value="settings.sampling.topP ?? ''" @input="setOptionalNumber('topP', $event)">
        </label>
        <label class="setting-label">Top K
          <input class="setting-input" type="number" min="1" max="1000" step="1"
                 :value="settings.sampling.topK ?? ''" @input="setOptionalNumber('topK', $event)">
        </label>
        <label class="setting-label">Seed
          <input class="setting-input" type="number" min="-2147483648" max="2147483647" step="1"
                 :value="settings.sampling.seed ?? ''" @input="setOptionalNumber('seed', $event)">
        </label>
        <label class="setting-label">Max output tokens
          <input class="setting-input" type="number" :min="minimumOutputTokens" :max="props.maxOutputTokens" step="1"
                 :value="settings.sampling.maxOutputTokens ?? ''" @input="setOptionalNumber('maxOutputTokens', $event)">
          <span class="setting-help">Minimum {{ minimumOutputTokens.toLocaleString() }} for this image tier; maximum {{ props.maxOutputTokens.toLocaleString() }}. Leave blank for the provider default.</span>
        </label>
      </div>
    </details>

    <details class="setting-section">
      <summary class="cursor-pointer text-sm font-semibold">Safety thresholds</summary>
      <p class="setting-help mt-1">Applied independently to each supported harm category.</p>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label v-for="field in safetyFields" :key="field.key" class="setting-label">
          {{ field.label }}
          <select v-model="settings.safety[field.key]" class="setting-input">
            <option v-for="option in safetyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.setting-label { display: block; font-size: 0.875rem; font-weight: 500; color: rgb(55 65 81); }
.setting-input { display: block; width: 100%; margin-top: 0.25rem; border: 1px solid rgb(209 213 219); border-radius: 0.375rem; padding: 0.5rem 0.625rem; background: transparent; font-weight: 400; }
.setting-help { display: block; margin-top: 0.25rem; font-size: 0.75rem; line-height: 1.25rem; color: rgb(107 114 128); }
.setting-card, .setting-section { border: 1px solid rgb(229 231 235); border-radius: 0.5rem; padding: 0.75rem; }
:global(.dark) .setting-label { color: rgb(209 213 219); }
:global(.dark) .setting-input, :global(.dark) .setting-card, :global(.dark) .setting-section { border-color: rgb(55 65 81); }
:global(.dark) .setting-help { color: rgb(156 163 175); }
</style>
