import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {hasMessage, translate} from './i18n-test-helpers.ts'

// The generation workspace (Edit, Same-origin batch, history cards and local
// background removal) renders its copy through message keys. Every literal key
// must resolve in both locales, and the capability tags required by AGENTS.md
// must stay visible in both languages.
const files = [
  'app/components/GeminiForm.vue',
  'app/components/systemPromp.vue',
  'app/components/BackgroundRemovalPanel.vue',
  'app/components/DownloadableImage.vue',
  'app/pages/edit.vue',
  'app/pages/same-origin-batch.vue',
  'app/utils/generationComposer.ts',
]
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('every literal generation-workspace message key exists in English and Hungarian', () => {
  for (const path of files) {
    const keys = [...read(path).matchAll(/'((?:generation|common)\.[A-Za-z0-9_.]+[A-Za-z0-9_])'/g)].map(match => match[1]!)
    assert.ok(keys.length > 0, `${path} must use message keys`)
    for (const key of keys) {
      assert.ok(hasMessage(key, 'en'), `${path}: ${key} is missing from en`)
      assert.ok(hasMessage(key, 'hu'), `${path}: ${key} is missing from hu`)
    }
  }
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']) {
    assert.ok(hasMessage(`generation.cutout.status.${status}`, 'en') && hasMessage(`generation.cutout.status.${status}`, 'hu'), status)
  }
})

test('workspace copy is not hard-coded in English in translated templates', () => {
  const form = read('app/components/GeminiForm.vue')
  for (const english of ['>Transparent<', '>New<', '>Recommended<', 'Model settings', 'Generation history', 'Run batch', 'Keep prompt and images', 'Gateway diagnostics']) {
    assert.equal(form.includes(english), false, `GeminiForm must translate ${english}`)
  }
  const card = read('app/components/systemPromp.vue')
  for (const english of ['Final price', 'Image expired', 'Refine this image', "'Regeneration failed'"]) assert.equal(card.includes(english), false, english)
  const panel = read('app/components/BackgroundRemovalPanel.vue')
  for (const english of ['Download PNG', 'Use in editor', 'Retry loading jobs', "'Ready'"]) assert.equal(panel.includes(english), false, english)
})

test('Transparent, New and Recommended tags stay visible and localized in every generation selector', () => {
  const form = read('app/components/GeminiForm.vue')
  // Both the selector rows and the selected-model summary carry the badge class and translated label.
  assert.equal(form.match(/class="model-transparent-badge"[^>]*>\{\{ t\('generation\.composer\.transparent'\) \}\}<\/UBadge>/g)?.length, 2)
  assert.equal(form.match(/\{\{ t\('generation\.composer\.new'\) \}\}<\/UBadge>/g)?.length, 2)
  assert.match(read('app/components/BackgroundRemovalPanel.vue'), /model-transparent-badge"[^>]*>\{\{ t\('generation\.composer\.transparent'\) \}\}/)
  assert.equal(translate('generation.composer.transparent'), 'Transparent')
  assert.equal(translate('generation.composer.new'), 'New')
  assert.equal(translate('generation.composer.recommended'), 'Recommended')
  assert.equal(translate('generation.composer.transparent', {}, 'hu'), 'Átlátszó')
  assert.equal(translate('generation.composer.new', {}, 'hu'), 'Új')
  assert.equal(translate('generation.composer.recommended', {}, 'hu'), 'Ajánlott')
})

test('curated model prose is localized through modelText, while model names stay as-is', () => {
  const form = read('app/components/GeminiForm.vue')
  for (const field of ['selectedProfile.description', 'selectedProfile.lifecycleNote', 'warning']) {
    assert.match(form, new RegExp(`modelText\\(${field.replace('.', '\\.')}\\)`))
  }
  assert.match(form, /\{\{ selectedProfile\.name \}\}/)
  assert.match(read('app/components/BackgroundRemovalPanel.vue'), /modelText\(profile\.description\)/)
})

test('client-authored errors keep message keys so a language switch re-translates them', () => {
  const form = read('app/components/GeminiForm.vue')
  assert.match(form, /const errorMsg = computed<string \| null>\(\{/)
  assert.match(form, /'key' in value \? t\(value\.key, value\.params \?\? \{\}\) : value\.text/)
  assert.match(form, /error instanceof ComposerValidationError\) \{ showError\(error\.messageKey\)/)
  assert.match(read('app/components/BackgroundRemovalPanel.vue'), /const errorMessage = computed\(\(\) => errorKey\.value \? t\(errorKey\.value\) : ''\)/)
  assert.equal(translate('generation.errors.outputsFailedOther', {count: 2, detail: 'Provider said no.'}), '2 outputs failed. Provider said no.')
  assert.equal(translate('generation.errors.outputsFailedOther', {count: 2, detail: 'Provider said no.'}, 'hu'), '2 kimenet sikertelen. Provider said no.')
})

test('history and diagnostics timestamps follow the active locale', () => {
  assert.match(read('app/components/systemPromp.vue'), /d\.toLocaleString\(locale\.value\)/)
  assert.match(read('app/components/GeminiForm.vue'), /new Date\(value\)\.toLocaleString\(locale\.value\)/)
})
