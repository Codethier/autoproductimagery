import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { IMAGE_MODEL_PROFILES, createDefaultSettings } from '../schemas/image-generation.ts'
import { localeMessages } from './i18n-test-helpers.ts'

const root = new URL('../', import.meta.url)
const settingsDirectory = new URL('app/components/generation-settings/', root)

// Compile the actual settings templates, including their explicit child imports.
// These components use Nuxt's Vue and i18n auto-imports but no Nuxt services.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~~/')) {
      return nextResolve(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(settingsDirectory.href) && url.endsWith('.vue')) {
      const filename = fileURLToPath(url)
      const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
      const compiled = compileScript(descriptor, { id: filename, inlineTemplate: true })
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(`import { computed, ref, watch } from 'vue';\nimport { useI18n } from 'vue-i18n';\n${compiled.content}`),
      }
    }
    return nextLoad(url, context)
  },
})

async function renderSettings(profile: typeof IMAGE_MODEL_PROFILES[keyof typeof IMAGE_MODEL_PROFILES], locale: 'en' | 'hu' = 'en') {
  const { default: component } = await import(new URL(`${profile.settingsComponent}.vue`, settingsDirectory).href)
  const warnings: string[] = []
  const app = createSSRApp({ render: () => h(component, { modelValue: createDefaultSettings(profile.id) }) })
  app.use(createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en: localeMessages('en'), hu: localeMessages('hu') } as any }))
  // Nuxt UI registers this globally; keep app-owned children unstubbed.
  app.component('UCheckbox', { props: ['label'], setup: (props: any) => () => h('label', [h('input', { type: 'checkbox' }), props.label]) })
  app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [], `${profile.id}: settings must render without Vue warnings`)
  assert.doesNotMatch(html, /models\.(settings|text)/, `${profile.id}: no raw message keys`)
  return html
}

test('every model renders settings on the server without unresolved child components', async () => {
  for (const profile of Object.values(IMAGE_MODEL_PROFILES)) {
    const html = await renderSettings(profile)
    assert.match(html, /class="setting-input"|This model chooses the output dimensions and format/, `${profile.id}: expected visible controls or the model-default explanation`)
    if (profile.provider === 'google') {
      assert.match(html, /Aspect ratio/, `${profile.id}: shared Gemini controls must render on initial load`)
    }
    if (profile.settingsComponent === 'OpenAiGptImage25Settings') {
      assert.match(html, /Custom size/)
      assert.match(html, /Number of images/)
    }
  }
})

test('settings render Hungarian labels, options and catalog prose when the locale is hu', async () => {
  for (const profile of Object.values(IMAGE_MODEL_PROFILES)) {
    const html = await renderSettings(profile, 'hu')
    assert.match(html, /class="setting-input"|Ez a modell maga választja meg a kimenet méreteit/, `${profile.id}: expected visible controls or the model-default explanation`)
    if (profile.provider === 'google') {
      assert.match(html, /Képarány/, `${profile.id}: shared Gemini controls are translated`)
      assert.match(html, /Mintavételi beállítások/)
      assert.doesNotMatch(html, />Aspect ratio<|Sampling controls/)
    }
    if (profile.settingsComponent === 'OpenAiGptImage25Settings') {
      assert.match(html, /Egyéni méret/)
      assert.match(html, /Képek száma/)
      assert.match(html, /<option value="transparent"[^>]*>Átlátszó<\/option>/, 'option labels translate while values stay unchanged')
      assert.doesNotMatch(html, /Custom size|Number of images/)
    }
  }
  const flux = await renderSettings(IMAGE_MODEL_PROFILES['bfl/flux-pro-1.1-ultra'], 'hu')
  assert.match(flux, /Referencia hatása/, 'catalog control labels from the schema are translated')
  assert.match(flux, /Mennyire erősen irányítja a feltöltött kép/, 'schema control help is translated')
  assert.match(flux, /Modell alapértéke/)
  assert.doesNotMatch(flux, /Reference influence|How strongly/)
  const muse = await renderSettings(IMAGE_MODEL_PROFILES['meta/muse-image-1.0'], 'hu')
  assert.match(muse, /Ez a modell maga választja meg a kimenet méreteit és formátumát/)
})
