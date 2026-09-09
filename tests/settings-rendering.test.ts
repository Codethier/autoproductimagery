import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, h } from 'vue'
import { IMAGE_MODEL_PROFILES, createDefaultSettings } from '../schemas/image-generation.ts'

const root = new URL('../', import.meta.url)
const settingsDirectory = new URL('app/components/generation-settings/', root)

// Compile the actual settings templates, including their explicit child imports.
// These components use Nuxt's Vue auto-imports but no Nuxt services.
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
        source: stripTypeScriptTypes(`import { computed, ref, watch } from 'vue';\n${compiled.content}`),
      }
    }
    return nextLoad(url, context)
  },
})

test('every model renders settings on the server without unresolved child components', async () => {
  for (const profile of Object.values(IMAGE_MODEL_PROFILES)) {
    const { default: component } = await import(new URL(`${profile.settingsComponent}.vue`, settingsDirectory).href)
    const warnings: string[] = []
    const app = createSSRApp({ render: () => h(component, { modelValue: createDefaultSettings(profile.id) }) })
    // Nuxt UI registers this globally; keep app-owned children unstubbed.
    app.component('UCheckbox', { render: () => h('input', { type: 'checkbox' }) })
    app.config.warnHandler = message => warnings.push(message)
    const html = await renderToString(app)
    assert.deepEqual(warnings, [], `${profile.id}: settings must render without Vue warnings`)
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
