<script setup lang="ts">
import type {NuxtError} from '#app'
const props = defineProps<{error: NuxtError<{workspaceWarmup?: boolean; retryPath?: string}>}>()
const warmup = computed(() => props.error.data?.workspaceWarmup === true)
const retryPath = computed(() => {
  const path = props.error.data?.retryPath
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(path) ? path : '/edit'
})
async function retry() {await clearError({redirect: retryPath.value})}
useHead({title: 'Workspace unavailable · Product Imagery', htmlAttrs: {class: 'dark'}})
</script>

<template>
  <main class="workspace-recovery">
    <span class="workspace-eyebrow">Product imagery</span>
    <h1>{{ warmup ? 'Your workspace is waking up' : 'Your workspace could not load' }}</h1>
    <p>{{ warmup ? 'The first request after being idle can take longer while the app and database start. Your session is preserved. Wait a moment, then try again.' : 'Please try loading your workspace again.' }}</p>
    <button type="button" @click="retry">Try again</button>
  </main>
</template>

<style scoped>
.workspace-recovery{min-height:100dvh;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:20px;max-width:640px;margin:auto;padding:40px;color:var(--workspace-text,#eee9df);background:var(--workspace-bg,#211e19)}.workspace-recovery h1{font-size:30px;line-height:1.3;letter-spacing:-.6px}.workspace-recovery p{font-size:14px;line-height:1.8;color:var(--workspace-muted,#ada294)}.workspace-recovery button{border-radius:10px;padding:12px 20px;background:var(--workspace-accent,#dbb889);color:#241c15;cursor:pointer}
</style>
