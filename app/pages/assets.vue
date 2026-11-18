<script setup lang="ts">
definePageMeta({layout: 'workspace', colorMode: 'dark'})
const route = useRoute()
const router = useRouter()
const initialPath = computed(() => typeof route.query.folder === 'string' && route.query.folder.startsWith('/') && !route.query.folder.startsWith('//') ? route.query.folder : '/')
function onNavigate(path: string) {
  void router.replace({path: '/assets', query: path === '/' ? {} : {folder: path}})
}
const {t} = useI18n()
useHead({title: computed(() => t('library.pageTitle'))})
</script>

<template>
  <AssetBrowser :initial-path="initialPath" @navigate="onNavigate"/>
</template>
