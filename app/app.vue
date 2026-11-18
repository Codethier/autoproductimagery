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
const {locale} = useI18n()
useHead({htmlAttrs: {class: 'dark', lang: locale}})
</script>
