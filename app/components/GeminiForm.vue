<script setup lang="ts">
const data = useDataStore()
const prompt = ref('')
const loading = ref(false)
const errorMsg = ref<string | null>(null)
let systemPrompts = ref()

async function submit() {
  if (loading.value) return
  errorMsg.value = null
  if (data.inputImages.length === 0) {
    errorMsg.value = 'Please select at least one input image.'
    return
  }
  try {
    loading.value = true
    const res = await $fetch<{ ok: boolean; url?: string; message?: string }>(
        '/api/gemini-normal',
        {
          method: 'POST',
          body: {
            prompt: prompt.value,
            inputImages: data.inputImages,
            modelImages: data.models,
            responseModalities: ['IMAGE']
          }
        }
    )

  } catch (e: any) {
    errorMsg.value = e?.message || 'Request failed'
  } finally {
    loading.value = false
  }
}

</script>

<template>
  <div>
    <div class="flex flex-col gap-2">
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton>Select Models</UButton>
        <template #content>
          <Files :is-model-select="true" class="overflow-y-auto"/>
        </template>
      </UModal>
      <p>These Images will get submitted with each Image</p>
      <div v-if="data.models.length > 0" class="grid grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="m in data.models" :key="m" :src="m" class="w-full object-contain"/>
      </div>
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton>Select Images</UButton>
        <template #content>
          <Files :is-image-select="true" class=" overflow-y-auto"/>
        </template>
      </UModal>
      <p>These Images will get submitted one by one </p>
      <div v-if="data.inputImages.length > 0" class="grid grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="i in data.inputImages" :key="i" :src="i"
                           class="w-full object-contain"/>
      </div>
      <div>
        <UTextarea v-model="prompt" class="w-full" placeholder="Prompt" autoresize/>
      </div>
      <div class="flex items-center gap-2">
        <UButton @click="submit()" :disabled="data.inputImages.length === 0 || loading">
          <span v-if="loading">Submitting...</span>
          <span v-else>Submit</span>
        </UButton>
        <span v-if="errorMsg" class="text-red-500 text-sm">{{ errorMsg }}</span>
      </div>

    </div>
    <div>
      <!--  past prompts here-->
    </div>
  </div>
</template>

<style scoped>

</style>