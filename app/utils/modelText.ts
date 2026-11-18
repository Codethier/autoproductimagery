/**
 * Localization of curated English model-catalog prose that comes from shared
 * schemas (profile descriptions, lifecycle notes, warnings, guidance, catalog
 * control labels, pipeline text and background-removal model text).
 *
 * The schemas stay English because servers, tests and stored settings rely on
 * them. The UI maps each exact English source string to a stable message key
 * under `models.text.<key>`; a few schema strings interpolate values, so they
 * are matched against static templates under `models.textTemplates.<id>`.
 * Anything unknown (for example a newly added model) renders its original
 * English text, never a raw key.
 */

export const MODEL_TEXT_PREFIX = 'models.text'
export const MODEL_TEXT_TEMPLATE_PREFIX = 'models.textTemplates'

/** FNV-1a 32-bit over UTF-16 code units, as 8 lowercase hex characters. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Deterministic message-key segment for an exact English source string: a
 * readable slug of its first words plus a hash of the whole text.
 */
export function modelTextKey(english: string): string {
  const slug = english.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4).join('_')
  return `${slug || 'text'}_${fnv1a(english)}`
}

export type ModelTextTemplate = {
  id: string
  pattern: RegExp
  params: readonly string[]
}

/**
 * Schema strings built from template literals. Each pattern reproduces the
 * exact English produced by the schema so the extracted values are reused in
 * the translated message. Keep in sync with `schemas/image-generation.ts` and
 * `schemas/image-model-guidance.ts`; a drifted pattern falls back to English.
 */
export const MODEL_TEXT_TEMPLATES: readonly ModelTextTemplate[] = [
  {
    id: 'catalogDescription',
    pattern: /^(.+) generates product imagery from text and uploaded pictures\.$/,
    params: ['name'],
  },
  {
    id: 'guidanceReferences',
    pattern: /^The source is the picture being edited\. Extra references guide identity, clothing, style, or composition\. This model accepts up to (\d+) pictures in one job, counting the source and references together\.$/,
    params: ['count'],
  },
  {
    id: 'guidanceOutputOne',
    pattern: /^1 output image per job with these settings\. Each batch input runs independently; shared references repeat for every input\. A request can produce at most 50 images\. Final prices appear after they are confirmed\.$/,
    params: [],
  },
  {
    id: 'guidanceOutputMany',
    pattern: /^(\d+) output images per job with these settings\. Each batch input runs independently; shared references repeat for every input\. A request can produce at most 50 images\. Final prices appear after they are confirmed\.$/,
    params: ['count'],
  },
]

export function matchModelTextTemplate(english: string): {key: string; params: Record<string, string>} | undefined {
  for (const template of MODEL_TEXT_TEMPLATES) {
    const match = template.pattern.exec(english)
    if (!match) continue
    const params = Object.fromEntries(template.params.map((name, index) => [name, match[index + 1] ?? '']))
    return {key: `${MODEL_TEXT_TEMPLATE_PREFIX}.${template.id}`, params}
  }
  return undefined
}

/** Escape literal vue-i18n syntax characters so a message renders verbatim. */
export function escapeModelTextMessage(text: string): string {
  return text.replace(/[@|{}]/g, character => `{'${character}'}`)
}

type ModelTextTranslator = {
  t: (key: string, params?: Record<string, unknown>) => string
  te?: (key: string) => boolean
}

/**
 * Builds the `modelText` helper from an i18n composer (`useI18n()`). Calls read
 * the composer's current locale, so use them in templates or computed values to
 * stay reactive to a language switch.
 */
export function createModelText(i18n: ModelTextTranslator) {
  const has = (key: string) => typeof i18n.te === 'function' ? i18n.te(key) : i18n.t(key) !== key
  const modelText = (english: string | undefined | null): string => {
    if (!english) return ''
    const key = `${MODEL_TEXT_PREFIX}.${modelTextKey(english)}`
    if (has(key)) return i18n.t(key)
    const template = matchModelTextTemplate(english)
    if (template && has(template.key)) return i18n.t(template.key, template.params)
    return english
  }
  const modelTextList = (items: readonly string[] | undefined | null): string[] => (items ?? []).map(modelText)
  return {modelText, modelTextList}
}
