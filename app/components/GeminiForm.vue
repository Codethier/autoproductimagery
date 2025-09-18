<script setup lang="ts">
let data = useDataStore()

</script>

<template>
  <div>
    <div class="flex flex-col gap-2">

      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton>Select Model</UButton>
        <template #content>
          <Files :is-model-select="true" class="overflow-y-auto"></Files>
        </template>
      </UModal>
      <p>These Images will get submited with each Image</p>
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton>Select Images</UButton>
        <template #content>
          <Files :is-image-select="true" class=" overflow-y-auto"></Files>
        </template>
      </UModal>
      <p>These will get submited one by one </p>
    </div>

  </div>
</template>

<style scoped>

</style>