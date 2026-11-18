import {readdirSync, readFileSync} from 'node:fs'
import {ref} from 'vue'

// A small stand-in for vue-i18n's useI18n() in source-compiled component
// tests. It reads the real locale files, so English assertions still prove the
// rendered copy, and missing keys surface as the raw key instead of passing.
const root = new URL('../i18n/locales/', import.meta.url)
const cache = new Map<string, Record<string, unknown>>()

export function localeMessages(locale = 'en'): Record<string, unknown> {
  let messages = cache.get(locale)
  if (!messages) {
    messages = {}
    for (const file of readdirSync(new URL(`${locale}/`, root)).filter(name => name.endsWith('.json'))) {
      Object.assign(messages, JSON.parse(readFileSync(new URL(`${locale}/${file}`, root), 'utf8')))
    }
    cache.set(locale, messages)
  }
  return messages
}

export function hasMessage(key: string, locale = 'en'): boolean {
  return typeof lookup(key, locale) === 'string'
}

function lookup(key: string, locale: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, localeMessages(locale))
}

export function translate(key: string, params: Record<string, unknown> = {}, locale = 'en'): string {
  const message = lookup(key, locale) ?? (locale === 'en' ? undefined : lookup(key, 'en'))
  if (typeof message !== 'string') return key
  return message.replace(/\{'([^']*)'\}|\{\s*([A-Za-z_]\w*)\s*\}/g, (_match, literal: string | undefined, name: string | undefined) =>
    literal !== undefined ? literal : String(params[name!] ?? ''))
}

export function useI18n(locale = 'en') {
  return {t: (key: string, params?: Record<string, unknown>) => translate(key, params, locale), locale: ref(locale)}
}

export const i18nTestHelpersUrl = new URL('./i18n-test-helpers.ts', import.meta.url).href
