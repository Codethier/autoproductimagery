import {useI18n} from 'vue-i18n'
import {createModelText} from '../utils/modelText'

/**
 * Localizes curated, English model-catalog prose that comes from shared
 * schemas (profile descriptions, lifecycle notes, warnings, guidance, catalog
 * control labels, pipeline text models, background-removal models). Unknown
 * text falls back to the English original, so a new model never renders a raw
 * message key. Call `modelText(...)` in templates or computed values so the
 * result follows a runtime language switch.
 */
export function useModelText(): {
  modelText: (english: string | undefined | null) => string
  modelTextList: (items: readonly string[] | undefined | null) => string[]
} {
  return createModelText(useI18n())
}
