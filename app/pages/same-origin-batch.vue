<script setup lang="ts">
definePageMeta({ layout: 'workspace', colorMode: 'dark' })
const { t } = useI18n()
useHead({ title: computed(() => `${t('common.layout.nav.sameOriginBatch')} · ${t('common.appName')}`) })
</script>

<template>
  <GeminiForm mode="batch" />
</template>
