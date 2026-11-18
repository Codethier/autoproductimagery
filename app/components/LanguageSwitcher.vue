<script setup lang="ts">
const {locale, locales, setLocale, t} = useI18n()
const options = computed(() => locales.value.map(entry => typeof entry === 'string' ? {code: entry, name: entry} : {code: entry.code, name: entry.name ?? entry.code}))
async function choose(event: Event) {
  const code = (event.target as HTMLSelectElement).value
  if (options.value.some(option => option.code === code) && code !== locale.value) await setLocale(code as typeof locale.value)
}
</script>

<template>
  <label class="language-switcher">
    <UIcon name="i-lucide-languages" aria-hidden="true" />
    <span class="sr-only">{{ t('common.language.label') }}</span>
    <select :value="locale" :aria-label="t('common.language.label')" @change="choose">
      <option v-for="option in options" :key="option.code" :value="option.code" :lang="option.code">{{ option.name }}</option>
    </select>
  </label>
</template>

<style scoped>
.language-switcher{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--workspace-muted,#ada294)}.language-switcher .iconify{width:13px;height:13px}.language-switcher select{background:transparent;color:inherit;border:1px solid var(--workspace-border,#3a342b);border-radius:8px;padding:4px 6px;font:inherit;cursor:pointer}.language-switcher select option{background:var(--workspace-bg,#211e19);color:var(--workspace-text,#eee9df)}
</style>
