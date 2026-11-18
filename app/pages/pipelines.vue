<script setup lang="ts">
definePageMeta({
  layout: "workspace",
  colorMode: "dark",
  key: "pipeline-workspace",
});
const { t } = useI18n();
useHead({ title: () => t("pipelines.pageTitle") });
</script>

<template><PipelinesWorkspace /></template>
