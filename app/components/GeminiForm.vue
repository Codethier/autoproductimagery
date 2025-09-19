<script setup lang="ts">
let data = useDataStore()
let prompt = ref('')

async function submit(){
console.log('call')
}

</script>

<template>
  <div>
    <div class="flex flex-col gap-2">
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton>Select Models</UButton>
        <template #content>
          <Files :is-model-select="true" class="overflow-y-auto"></Files>
        </template>
      </UModal>
      <p>These Images will get submitted with each Image</p>
      <div v-if="data.models.length > 0" class="grid grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="m in data.models" :key="m" :src="m" class="w-full object-contain"></DownloadableImage>
      </div>
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton>Select Images</UButton>
        <template #content>
          <Files :is-image-select="true" class=" overflow-y-auto"></Files>
        </template>
      </UModal>
      <p>These Images will get submitted one by one </p>
      <div v-if="data.inputImages.length > 0" class="grid grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="i in data.inputImages" :key="i" :src="i"
                           class="w-full object-contain"></DownloadableImage>
      </div>
      <div>
        <UTextarea class="w-full" placeholder="Prompt" autoresize ></UTextarea>
      </div>
      <UButton @click="submit()" :disabled="data.inputImages.length === 0">Submit</UButton>
    </div>
    <div>
      <!--  past prompts here-->
    </div>
  </div>
</template>

<style scoped>

</style>