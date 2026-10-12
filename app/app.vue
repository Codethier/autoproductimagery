<template>
  <div>
    <UApp>
      <NuxtLayout>
        <NuxtPage/>
      </NuxtLayout>
    </UApp>
  </div>
</template>
<script setup lang="ts">
useHead({htmlAttrs: {class: 'dark'}})
</script>
