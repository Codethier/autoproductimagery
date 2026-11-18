<script setup lang="ts">
import type {NuxtError} from '#app'
const props = defineProps<{error: NuxtError<{workspaceWarmup?: boolean; retryPath?: string}>}>()
// The recovery screen must still render if an error happens before i18n is
// available, so it falls back to English copy instead of failing again.
const english: Record<string, string> = {
  'common.appName': 'Product imagery',
  'common.actions.retry': 'Try again',
  'account.recovery.pageTitle': 'Workspace unavailable · Product Imagery',
  'account.recovery.warmupTitle': 'Your workspace is waking up',
  'account.recovery.failedTitle': 'Your workspace could not load',
  'account.recovery.warmupBody': 'The first request after being idle can take longer while the app and database start. Your session is preserved. Wait a moment, then try again.',
  'account.recovery.failedBody': 'Please try loading your workspace again.',
}
let t: (key: string) => string
try { const i18n = useI18n(); t = key => i18n.t(key) } catch { t = key => english[key] ?? key }
const warmup = computed(() => props.error.data?.workspaceWarmup === true)
const retryPath = computed(() => {
  const path = props.error.data?.retryPath
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(path) ? path : '/edit'
})
async function retry() {await clearError({redirect: retryPath.value})}
useHead({title: computed(() => t('account.recovery.pageTitle')), htmlAttrs: {class: 'dark'}})
</script>

<template>
  <main class="workspace-recovery">
    <span class="workspace-eyebrow">{{ t('common.appName') }}</span>
    <h1>{{ warmup ? t('account.recovery.warmupTitle') : t('account.recovery.failedTitle') }}</h1>
    <p>{{ warmup ? t('account.recovery.warmupBody') : t('account.recovery.failedBody') }}</p>
    <button type="button" @click="retry">{{ t('common.actions.retry') }}</button>
  </main>
</template>

<style scoped>
.workspace-recovery{min-height:100dvh;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:20px;max-width:640px;margin:auto;padding:40px;color:var(--workspace-text,#eee9df);background:var(--workspace-bg,#211e19)}.workspace-recovery h1{font-size:30px;line-height:1.3;letter-spacing:-.6px}.workspace-recovery p{font-size:14px;line-height:1.8;color:var(--workspace-muted,#ada294)}.workspace-recovery button{border-radius:10px;padding:12px 20px;background:var(--workspace-accent,#dbb889);color:#241c15;cursor:pointer}
</style>
