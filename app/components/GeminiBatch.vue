<script setup lang="ts">
import {useBase64FromFile} from "~/composables/useBase64FromFile";
import type {GenerateOptions} from "~~/schemas/main.dto";

let runtimeConfig = useRuntimeConfig()

const img: Ref<File[]> = ref([])
const prompt = ref('')
const model = ref(runtimeConfig.public.GeminiModels.gemini25FlashIOImagePreview)
const ref1 = ref()

let Base64FromFile = useBase64FromFile()

async function getFile(file: File) {
  return await useBase64FromFile().fileToBase64Raw(file)
}

async function submit() {
  let images = await Promise.all(img.value.map(getFile))
  let body: GenerateOptions = {
    inputImages: images, prompt: prompt.value, responseModalities: ['IMAGE']
  }
  let res = await $fetch('/api/gemini-batch', {
    method: 'POST',
    body: body
  })

}

</script>

<template>
  <div>
    <h2>Model</h2>
    <UInput v-model="model"></UInput>
    <h2>prompt</h2>
    <UInput v-model="prompt"></UInput>
    <UFileUpload v-model:model-value="img" multiple class="w-96 min-h-48"/>
    <div v-if="img.length > 0" class="flex gap-2">
      <UButton @click="submit">Read</UButton>
    </div>

  </div>
</template>

<style scoped>

</style>