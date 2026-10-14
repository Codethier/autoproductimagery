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
        <p class="setting-help">The output shape: 1:1 is square, 16:9 is wide, and 9:16 is tall. Default follows the first reference’s ratio or uses 1:1 without a reference.</p>
      </div>
      <div class="setting-card">
        <UCheckbox v-model="settings.includeText" label="Return model text with the image" />
        <p class="setting-help">Stores any explanatory text returned alongside the generated image.</p>
      </div>
    </div>

    <details class="setting-section">
      <summary class="cursor-pointer text-sm font-semibold">Sampling controls</summary>
      <p class="setting-help mt-1">Optional advanced controls. Start with blank values to use the provider defaults; tuning sampling can make instruction following less reliable.</p>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label class="setting-label">Temperature
          <input class="setting-input" type="number" min="0" max="2" step="0.01"
                 :value="settings.sampling.temperature ?? ''" @input="setOptionalNumber('temperature', $event)">
          <span class="setting-help">Randomness in the model’s choices. Higher values can vary the result; this does not control resolution or image quality.</span>
        </label>
        <label class="setting-label">Top P
          <input class="setting-input" type="number" min="0" max="1" step="0.01"
                 :value="settings.sampling.topP ?? ''" @input="setOptionalNumber('topP', $event)">
          <span class="setting-help">Limits choices by their combined probability. Leave blank unless you are deliberately comparing sampling settings.</span>
        </label>
        <label class="setting-label">Top K
          <input class="setting-input" type="number" min="1" max="1000" step="1"
                 :value="settings.sampling.topK ?? ''" @input="setOptionalNumber('topK', $event)">
          <span class="setting-help">Limits the number of likely choices considered at each step, when supported by the provider.</span>
        </label>
        <label class="setting-label">Seed
          <input class="setting-input" type="number" min="-2147483648" max="2147483647" step="1"
                 :value="settings.sampling.seed ?? ''" @input="setOptionalNumber('seed', $event)">
          <span class="setting-help">Optional starting value for randomness. The same seed does not guarantee the same picture or preserve a person’s identity.</span>
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
