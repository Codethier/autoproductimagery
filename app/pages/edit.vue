<script setup lang="ts">
definePageMeta({ layout: 'workspace', colorMode: 'dark' })
const { t } = useI18n()
useHead({ title: computed(() => `${t('common.layout.nav.edit')} · ${t('common.appName')}`) })
</script>

<template>
  <GeminiForm mode="edit" />
</template>
