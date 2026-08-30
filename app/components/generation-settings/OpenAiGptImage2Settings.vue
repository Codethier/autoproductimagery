<script setup lang="ts">
import {
  isValidGptImage2Size,
  type OpenAiGptImage2Settings,
} from '~~/schemas/image-generation'

const settings = defineModel<OpenAiGptImage2Settings>({required: true})
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
      <label class="text-sm font-medium">Custom size
        <input v-model="sizeValue" class="setting-input" placeholder="Model default, e.g. 1024x1024">
        <span class="setting-help">Both edges must be divisible by 16; max edge 3840; ratio at most 3:1; 655,360–8,294,400 pixels.</span>
        <span v-if="sizeError" class="setting-error">This size does not meet GPT Image 2 constraints.</span>
      </label>
      <label class="text-sm font-medium">Quality
        <select v-model="settings.quality" class="setting-input">
          <option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
        <span class="setting-help">Low is fastest; high uses more output tokens.</span>
      </label>
      <label class="text-sm font-medium">Background
        <select v-model="settings.background" class="setting-input">
          <option value="auto">Auto</option><option value="opaque">Opaque</option>
        </select>
        <span class="setting-help">Transparent backgrounds are not supported.</span>
      </label>
      <label class="text-sm font-medium">Output format
        <select v-model="settings.outputFormat" class="setting-input">
          <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
        </select>
        <span class="setting-help">JPEG is usually fastest; PNG disables compression.</span>
      </label>
      <label class="text-sm font-medium">Output compression
        <input class="setting-input" type="number" min="0" max="100" step="1"
               :disabled="compressionDisabled" :value="settings.outputCompression ?? ''" @input="setCompression">
        <span class="setting-help">Optional, 0–100. Available only for JPEG and WebP.</span>
      </label>
      <label class="text-sm font-medium">Moderation
        <select v-model="settings.moderation" class="setting-input">
          <option value="auto">Auto</option><option value="low">Low (less restrictive)</option>
        </select>
        <span class="setting-help">All prompts and generated images remain filtered.</span>
      </label>
      <label class="text-sm font-medium">Number of images
        <input v-model.number="settings.numberOfImages" class="setting-input" type="number" min="1" max="10" step="1">
        <span class="setting-help">Creates 1–10 outputs for each generation job.</span>
      </label>
      <label class="text-sm font-medium sm:col-span-2">End-user identifier
        <input v-model="userValue" class="setting-input" maxlength="256" placeholder="Optional stable user ID">
        <span class="setting-help">Helps OpenAI monitor abuse. Do not enter a name, email address, or other personal data.</span>
      </label>
    </div>
    <div class="rounded-lg border border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
      Input fidelity is always high. Seed, style, transparent background, and a separate aspect-ratio field are intentionally unavailable.
    </div>
  </div>
</template>

<style scoped>
.setting-input { display:block; width:100%; margin-top:.25rem; border:1px solid rgb(209 213 219); border-radius:.375rem; padding:.5rem .625rem; background:transparent; font-weight:400; }
.setting-input:disabled { opacity:.55; cursor:not-allowed; } .setting-help { display:block; margin-top:.25rem; font-size:.75rem; line-height:1.25rem; color:rgb(107 114 128); }
.setting-error { display:block; margin-top:.25rem; font-size:.75rem; color:rgb(220 38 38); }
:global(.dark) .setting-input { border-color:rgb(55 65 81); } :global(.dark) .setting-help { color:rgb(156 163 175); }
</style>
