import assert from 'node:assert/strict'
import {readdirSync, readFileSync} from 'node:fs'
import test from 'node:test'

// English and Hungarian message files must stay in lockstep: identical keys,
// non-empty strings, the same named placeholders, and no characters that
// vue-i18n would parse as message syntax by accident.
const root = new URL('../i18n/locales/', import.meta.url)
const LOCALES = ['en', 'hu'] as const
const config = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
const namespaces = JSON.parse(config.match(/const I18N_NAMESPACES = (\[[^\]]*\])/)![1]!.replaceAll("'", '"')) as string[]

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof value === 'string') { out.set(prefix, value); return out }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${prefix} must be a string or an object`)
  for (const [key, child] of Object.entries(value)) {
    for (const [path, text] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(path, text)
  }
  return out
}
const load = (locale: string, namespace: string) => JSON.parse(readFileSync(new URL(`${locale}/${namespace}.json`, root), 'utf8'))
const placeholders = (text: string) => [...text.matchAll(/\{\s*([A-Za-z_][\w]*)\s*\}/g)].map(match => match[1]).sort()

test('every configured namespace exists for every locale and no stray files are present', () => {
  for (const locale of LOCALES) {
    const files = readdirSync(new URL(`${locale}/`, root)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort()
    assert.deepEqual(files, [...namespaces].sort(), `${locale} message files`)
  }
})

test('each namespace file owns exactly its own top-level key', () => {
  for (const locale of LOCALES) for (const namespace of namespaces) {
    assert.deepEqual(Object.keys(load(locale, namespace)), [namespace], `${locale}/${namespace}.json`)
  }
})

test('English and Hungarian messages have identical keys and placeholders', () => {
  for (const namespace of namespaces) {
    const en = flatten(load('en', namespace)), hu = flatten(load('hu', namespace))
    const missingHu = [...en.keys()].filter(key => !hu.has(key)), missingEn = [...hu.keys()].filter(key => !en.has(key))
    assert.deepEqual(missingHu, [], `${namespace}: keys missing from hu`)
    assert.deepEqual(missingEn, [], `${namespace}: keys missing from en`)
    for (const [key, text] of en) {
      assert.ok(text.trim(), `en ${key} is empty`)
      assert.ok(hu.get(key)!.trim(), `hu ${key} is empty`)
      assert.deepEqual(placeholders(hu.get(key)!), placeholders(text), `${key}: placeholders differ`)
    }
  }
})

test('messages avoid unescaped vue-i18n syntax characters', () => {
  for (const locale of LOCALES) for (const namespace of namespaces) {
    for (const [key, text] of flatten(load(locale, namespace))) {
      // Literal @, |, { and } must use the {'…'} literal form.
      const stripped = text.replace(/\{'[^']*'\}/g, '').replace(/\{\s*[A-Za-z_][\w]*\s*\}/g, '')
      assert.doesNotMatch(stripped, /[@|{}]/, `${locale} ${key} contains an unescaped message syntax character`)
    }
  }
})
