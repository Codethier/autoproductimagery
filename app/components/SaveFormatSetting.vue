<script setup lang="ts">
import type { ImageSaveFormat } from '~~/schemas/image-generation'
const props = defineProps<{modelValue: ImageSaveFormat; compact?: boolean; disabled?: boolean}>()
const emit = defineEmits<{'update:modelValue': [value: ImageSaveFormat]}>()
const {t} = useI18n()
const id = useId()
function choose(event: Event) {
  if (props.disabled) return
  const value = (event.target as HTMLSelectElement).value
  if (value === 'webp' || value === 'png' || value === 'original') emit('update:modelValue', value)
}
</script>

<template>
  <label class="save-format-setting text-sm font-medium" :class="{'save-format-setting--compact': compact}" :for="id">
    {{ t('common.saveFormat.label') }}
    <select :id="id" class="setting-input" :value="props.modelValue" :disabled="props.disabled" :aria-describedby="`${id}-help`" @change="choose">
      <option value="webp">{{ t('common.saveFormat.webp') }}</option>
      <option value="png">{{ t('common.saveFormat.png') }}</option>
      <option value="original">{{ t('common.saveFormat.original') }}</option>
    </select>
    <span :id="`${id}-help`" class="setting-help">{{ t(`common.saveFormat.${props.modelValue}Help`) }}</span>
  </label>
</template>

<style scoped>
.save-format-setting{display:grid;gap:6px}.save-format-setting--compact{gap:4px}
</style>
