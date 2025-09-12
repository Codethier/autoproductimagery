<script setup lang="ts">
let path = ref('/')

let items = await useFetch('/api/files', {deep: true, query: {path: path.value}})

</script>

<template>
  <div>
    <div>
      <h1 @click="items.refresh()">{{ path }}</h1>
      {{ items.data }}
      <div class="flex gap-2">
        <div v-for="dir of items.data.value?.dirs" class="flex items-center gap-2 flex-col">
          <UIcon name="material-symbols-create-new-folder" class="size-30"></UIcon>
          {{ dir.name }}
        </div>
        <div v-for="file of items.data.value?.files">
          {{ file.name }}
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>

</style>