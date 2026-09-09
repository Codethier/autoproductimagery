<script setup lang="ts">
import {
  GPT_IMAGE_LEGACY_SIZES,
  type OpenAiGptImageLegacySettings,
} from '~~/schemas/image-generation'

const settings = defineModel<OpenAiGptImageLegacySettings>({required: true})
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
      <label class="text-sm font-medium">Output size
        <select :value="settings.size ?? ''" class="setting-input" @change="setSize">
          <option value="">Model default</option>
          <option v-for="size in GPT_IMAGE_LEGACY_SIZES" :key="size" :value="size">{{ size }}</option>
        </select>
      </label>
      <label class="text-sm font-medium">Quality
        <select v-model="settings.quality" class="setting-input">
          <option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
        <span class="setting-help">Higher quality can take longer and use more output tokens.</span>
      </label>
      <label class="text-sm font-medium">Background
        <select v-model="settings.background" class="setting-input">
          <option value="auto">Auto</option><option value="opaque">Opaque</option><option value="transparent">Transparent</option>
        </select>
        <span class="setting-help">Transparent backgrounds require PNG or WebP.</span>
      </label>
      <label class="text-sm font-medium">Output format
        <select v-model="settings.outputFormat" class="setting-input">
          <option value="png">PNG</option><option value="jpeg" :disabled="settings.background === 'transparent'">JPEG</option><option value="webp">WebP</option>
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
      Each selected product image gets its own generation job.
    </div>
  </div>
</template>
