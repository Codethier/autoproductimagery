<script setup lang="ts">
import {
  CATALOG_IMAGE_DEFINITIONS, CatalogImageSettingsSchema,
  type CatalogImageSettings, type CatalogImageControl,
} from '~~/schemas/catalog-image-models'
import {imageControlHelp} from '~~/schemas/image-model-guidance'
import {createModelText} from '../../utils/modelText'

const settings = defineModel<CatalogImageSettings>({required: true})
const i18n = useI18n()
const {t} = i18n
// Curated English control labels and help come from shared schemas.
const {modelText} = createModelText(i18n)
const definition = computed(() => CATALOG_IMAGE_DEFINITIONS[settings.value.kind])
const invalid = ref(false)
function valueFor(key: CatalogImageControl['key']) {
  const value: unknown = Reflect.get(settings.value, key)
  return typeof value === 'string' || typeof value === 'number' ? value : ''
}
function checkedFor(key: CatalogImageControl['key']) {
  return Reflect.get(settings.value, key) === true
}
function update(control: CatalogImageControl, event: Event) {
  const input = event.target as HTMLInputElement
  const value = control.type === 'checkbox' ? input.checked
    : input.value === '' && control.optional ? undefined
    : control.type === 'number' ? Number(input.value) : input.value
  const parsed = CatalogImageSettingsSchema.safeParse({...settings.value, [control.key]: value})
  invalid.value = !parsed.success
  if (parsed.success) settings.value = parsed.data
}
watch(() => settings.value.kind, () => { invalid.value = false }, {flush: 'sync'})
</script>

<template>
  <div class="space-y-3">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label v-for="control in definition.controls" :key="`${settings.kind}:${control.key}`" class="text-sm font-medium">
        {{ modelText(control.label) }}
        <select v-if="control.type === 'select'" class="setting-input" :value="valueFor(control.key)" @change="update(control, $event)">
          <option v-if="control.optional" value="">{{ t('models.settings.modelDefault') }}</option>
          <option v-for="option in control.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <input v-else-if="control.type === 'checkbox'" type="checkbox" class="ml-2" :checked="checkedFor(control.key)" @change="update(control, $event)">
        <input v-else class="setting-input" type="number" :min="control.min" :max="control.max" :step="control.step"
               :placeholder="control.optional ? t('models.settings.modelDefault') : undefined" :value="valueFor(control.key)" @change="update(control, $event)">
        <span v-if="imageControlHelp(settings.kind, control.key)" class="setting-help">{{ modelText(imageControlHelp(settings.kind, control.key)) }}</span>
      </label>
    </div>
    <p v-if="!definition.controls.length" class="text-sm text-gray-500">{{ t('models.settings.catalog.noControls') }}</p>
    <p v-if="invalid" role="alert" class="text-sm text-red-600">{{ t('models.settings.catalog.invalidValue') }}</p>
  </div>
</template>
