import assert from 'node:assert/strict'
import test from 'node:test'
import {createI18n} from 'vue-i18n'
import {CATALOG_IMAGE_DEFINITIONS} from '../schemas/catalog-image-models.ts'
import {IMAGE_MODEL_PROFILES} from '../schemas/image-generation.ts'
import {
  MODEL_TEXT_PREFIX, MODEL_TEXT_TEMPLATES, createModelText, escapeModelTextMessage, matchModelTextTemplate, modelTextKey,
} from '../app/utils/modelText.ts'
import {hasMessage, localeMessages, useI18n as useStandInI18n} from './i18n-test-helpers.ts'
import {curatedModelTexts} from './model-text-sources.ts'

// Curated model prose lives in English in the shared schemas. The UI maps each
// exact string to `models.text.<modelTextKey(text)>`, or to a static template
// for schema strings that interpolate values. This test enumerates every
// UI-visible curated string, so adding or rewording a model without Hungarian
// fails here with the key and English text that must be added to both
// i18n/locales/en/models.json and i18n/locales/hu/models.json.
function composer(locale: 'en' | 'hu') {
  return createI18n({legacy: false, locale, fallbackLocale: 'en', missingWarn: false, fallbackWarn: false,
    messages: {en: localeMessages('en'), hu: localeMessages('hu')} as any}).global
}

test('every curated model string has English and Hungarian messages', () => {
  const missing: string[] = []
  for (const [text, source] of curatedModelTexts()) {
    const template = matchModelTextTemplate(text)
    const key = template?.key ?? `${MODEL_TEXT_PREFIX}.${modelTextKey(text)}`
    for (const locale of ['en', 'hu'] as const) {
      if (!hasMessage(key, locale)) missing.push(`${locale} ${key} (${source}): ${template ? 'template' : escapeModelTextMessage(text)}`)
    }
  }
  assert.deepEqual(missing, [], 'add these entries to models.json in both locales')
})

test('English messages reproduce the schema text exactly, and Hungarian differs where prose is translated', () => {
  const {modelText: en} = createModelText(composer('en'))
  const {modelText: hu} = createModelText(composer('hu'))
  const untranslatedNames = new Set(['Seed', 'BiRefNet Lite'])
  for (const text of curatedModelTexts().keys()) {
    assert.equal(en(text), text, `en must render the original English: ${text}`)
    const translated = hu(text)
    assert.ok(translated.trim(), text)
    if (!untranslatedNames.has(text)) assert.notEqual(translated, text, `hu must translate: ${text}`)
  }
})

test('message keys are unique per curated string and every stored entry is still used', () => {
  const owners = new Map<string, string>()
  for (const text of curatedModelTexts().keys()) {
    if (matchModelTextTemplate(text)) continue
    const key = modelTextKey(text)
    assert.ok(/^[a-z0-9_]+$/.test(key), key)
    assert.equal(owners.get(key) ?? text, text, `key collision for ${key}`)
    owners.set(key, text)
  }
  const stored = Object.keys((localeMessages('en') as any).models.text)
  assert.deepEqual(stored.filter(key => !owners.has(key)), [], 'stale models.text entries no longer match any schema string')
  const templates = Object.keys((localeMessages('en') as any).models.textTemplates).sort()
  assert.deepEqual(templates, MODEL_TEXT_TEMPLATES.map(template => template.id).sort())
})

test('interpolated schema strings use static templates with their values', () => {
  const {modelText} = createModelText(composer('hu'))
  const description = IMAGE_MODEL_PROFILES['bfl/flux-2-pro'].description
  assert.equal(description, 'FLUX.2 Pro generates product imagery from text and uploaded pictures.')
  assert.equal(modelText(description), 'FLUX.2 Pro – termékképek generálása szövegből és feltöltött képekből.')
  // A future catalog model reuses the template without its own entry.
  assert.equal(modelText('Imaginary Model 9 generates product imagery from text and uploaded pictures.'), 'Imaginary Model 9 – termékképek generálása szövegből és feltöltött képekből.')
  assert.match(modelText('7 output images per job with these settings. Each batch input runs independently; shared references repeat for every input. A request can produce at most 50 images. Final prices appear after they are confirmed.'), /feladatonként 7 kimeneti kép/)
  assert.equal(createModelText(composer('en')).modelText(description), description)
})

test('unknown text falls back to the original English, never a raw key', () => {
  for (const locale of ['en', 'hu'] as const) {
    const {modelText, modelTextList} = createModelText(composer(locale))
    assert.equal(modelText('A newly added model with no translation yet.'), 'A newly added model with no translation yet.')
    assert.equal(modelText('Uses {braces} and an @ sign | pipe'), 'Uses {braces} and an @ sign | pipe')
    assert.equal(modelText(undefined), '')
    assert.equal(modelText(null), '')
    assert.deepEqual(modelTextList(['Unknown warning.']), ['Unknown warning.'])
  }
  // A Hungarian gap falls back to English rather than showing the key.
  const partial = createI18n({legacy: false, locale: 'hu', fallbackLocale: 'en', missingWarn: false, fallbackWarn: false,
    messages: {en: localeMessages('en'), hu: {models: {}}} as any}).global
  const warning = CATALOG_IMAGE_DEFINITIONS['bfl/flux-2-pro'].warnings[0]!
  assert.equal(createModelText(partial).modelText(warning), warning)
})

test('translations follow a runtime language switch', () => {
  const i18n = composer('en'), {modelText, modelTextList} = createModelText(i18n)
  const warnings = IMAGE_MODEL_PROFILES['openai/gpt-image-2.5-sunburst'].warnings
  assert.deepEqual(modelTextList(warnings), [...warnings])
  i18n.locale.value = 'hu'
  assert.equal(modelText('Transparent backgrounds require PNG or WebP output.'), 'Átlátszó háttérhez PNG vagy WebP kimenet szükséges.')
  assert.notDeepEqual(modelTextList(warnings), [...warnings])
})

test('the helper also works with a t-only test stand-in for useI18n', () => {
  const {modelText} = createModelText(useStandInI18n('hu'))
  assert.equal(modelText('Output size'), 'Kimeneti méret')
  assert.equal(modelText('Not a curated string.'), 'Not a curated string.')
  assert.equal(modelText(IMAGE_MODEL_PROFILES['meta/muse-image-1.0'].description), 'Muse Image 1.0 – termékképek generálása szövegből és feltöltött képekből.')
})
