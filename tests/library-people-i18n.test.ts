import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {hasMessage} from './i18n-test-helpers.ts'

// Every message key referenced by the Library, sharing and People UI must
// exist in both locales; a typo would otherwise render a raw key.
const files = [
  'app/components/AssetBrowser.vue', 'app/components/files.vue', 'app/pages/assets.vue', 'app/pages/shared.vue',
  'app/components/PeopleBrowser.vue', 'app/components/PersonGenerator.vue', 'app/pages/people.vue', 'app/utils/assetPreferences.ts',
]

test('Library and People sources only reference messages present in English and Hungarian', () => {
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const keys = [...source.matchAll(/'((?:library|people|common)\.[A-Za-z0-9_.]+[A-Za-z0-9_])'/g)].map(match => match[1]!)
    if (file !== 'app/utils/assetPreferences.ts') assert.ok(keys.length, `${file} uses translated messages`)
    for (const key of keys) {
      if (key.endsWith('.')) continue
      for (const locale of ['en', 'hu']) assert.ok(hasMessage(key, locale), `${file}: ${locale} is missing ${key}`)
    }
  }
})

test('upload validation keys built from a template prefix exist in both locales', () => {
  const source = readFileSync(new URL('../app/utils/assetPreferences.ts', import.meta.url), 'utf8')
  const keys = [...source.matchAll(/key: '(library\.upload\.validation\.\w+)'/g)].map(match => match[1]!)
  assert.equal(keys.length, 6)
  for (const key of keys) for (const locale of ['en', 'hu']) assert.ok(hasMessage(key, locale), `${locale} ${key}`)
})

test('Library and People templates no longer hard-code the translated English copy', () => {
  const checks: Array<[string, RegExp]> = [
    ['app/components/AssetBrowser.vue', />\s*(Upload images|New folder|Shared with me|Delete permanently|People with access|Use in editor)\s*</],
    ['app/components/PeopleBrowser.vue', />\s*(Create person|My people|Edit profile|Remove profile|Generate pictures|Share person|Add from library)\s*</],
    ['app/components/PersonGenerator.vue', />\s*(Identity references|Image model|Variations|Model settings|Generate pictures|Transparent|New)\s*</],
    ['app/components/PersonGenerator.vue', /' · (New|Transparent|mask required|unavailable)'/],
    ['app/pages/shared.vue', /useHead\(\{title: '/],
    ['app/pages/people.vue', /useHead\(\{title: '/],
    ['app/pages/assets.vue', /useHead\(\{title: '/],
  ]
  for (const [file, pattern] of checks) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), pattern, file)
  }
})
