import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createSSRApp, h} from 'vue'
import {IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, createDefaultSettings, type ImageModelId} from '../schemas/image-generation.ts'
import {getImageModelGuidance, imageControlHelp} from '../schemas/image-model-guidance.ts'

const componentUrl = new URL('../app/components/ModelGuidance.vue', import.meta.url).href
registerHooks({load(url, context, next) {
  if (url !== componentUrl) return next(url, context)
  const filename = fileURLToPath(url), {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
  const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true, templateOptions: {compilerOptions: {hoistStatic: false}}})
  return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(compiled.content)}
}})
async function render(modelId: string, settings = createDefaultSettings(modelId as ImageModelId), context: 'generation' | 'people' | 'pipeline' = 'generation') {
  const {default: Component} = await import(componentUrl)
  const app = createSSRApp({render: () => h(Component, {modelId, settings, context})})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app); assert.deepEqual(warnings, [])
  return html
}

test('every exact image profile has curated usable guidance without changing its defaults', () => {
  for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
    const settings = createDefaultSettings(id), snapshot = structuredClone(settings)
    const guidance = getImageModelGuidance(id, settings)
    assert.ok(guidance, id); assert.ok(guidance.purpose.length > 30, id)
    assert.equal(guidance.modelName, IMAGE_MODEL_PROFILES[id].name)
    assert.equal(Boolean(guidance.mask), IMAGE_MODEL_PROFILES[id].supportsMask, id)
    assert.equal(guidance.transparency.includes('choose Background → Transparent'), IMAGE_MODEL_PROFILES[id].supportsTransparentBackground, id)
    assert.deepEqual(settings, snapshot, `${id}: help must not mutate settings`)
    if (IMAGE_MODEL_PROFILES[id].supportsMask) assert.ok(IMAGE_MODEL_PROFILES[id].maskMode, `${id}: mask meaning is explicit`)
  }
  assert.equal(getImageModelGuidance('openai/invented-mask-model'), undefined)
  assert.equal(imageControlHelp('openai/invented-mask-model', 'size'), undefined)
})

test('Sunburst describes alpha editing guidance and output transparency separately', async () => {
  const id = 'openai/gpt-image-2.5-sunburst', settings = createDefaultSettings(id)
  const html = await render(id, settings)
  assert.match(html, /Edit mask · transparent areas change/)
  assert.match(html, /Fully transparent areas mark what to change; opaque areas mark what to keep/)
  assert.match(html, /model can still change details outside the mask/)
  assert.match(html, /source must also be PNG and match the mask/)
  assert.match(html, /prepared in a separate image editor/)
  assert.match(html, /Background → Transparent/)
  assert.match(html, /PNG or WebP/)
  assert.doesNotMatch(html, /white selects the replacement area/)
  assert.equal('background' in settings && settings.background, 'auto')
  assert.ok('background' in settings); settings.background = 'transparent'
  const active = await render(id, settings)
  assert.match(active, /Transparent output is selected/)
  assert.match(active, /input edit mask and an output transparent background are separate choices/)
})

test('FLUX Fill has luminance semantics, and unmasked generators never show alpha instructions', async () => {
  const fill = await render('bfl/flux-pro-1.0-fill', undefined, 'pipeline')
  assert.match(fill, /Fill mask · white replaces, black keeps/)
  assert.match(fill, /White selects the replacement area; black keeps the original area/)
  assert.match(fill, /black-and-white PNG/)
  assert.match(fill, /Connect the source to the image input and the prepared mask to Mask/)
  assert.doesNotMatch(fill, /Fully transparent areas mark/)
  for (const id of ['google/gemini-3.1-flash-image', 'bfl/flux-2-pro', 'bytedance/seedream-5.0-pro'] as const) {
    const html = await render(id)
    assert.doesNotMatch(html, /Preparing a mask|Edit mask ·|Fill mask ·/)
    assert.match(html, /Transparent output is not available through this model in this app/)
    assert.match(html, /PNG alone does not make a cutout/)
  }
})

test('People guidance explains its own four-picture limit without offering a mask upload', async () => {
  const html = await render('openai/gpt-image-2.5-sunburst', undefined, 'people')
  assert.match(html, /People generator uses identity references without a separate mask/)
  assert.match(html, /People factory accepts at most 4 pictures per request/)
  assert.doesNotMatch(html, /Preparing a mask|Example prompt|A request can produce at most 50 images/)
})

test('output guidance uses only settings belonging to the selected model', () => {
  const settings = createDefaultSettings('openai/gpt-image-2.5-sunburst')
  assert.ok('numberOfImages' in settings); settings.numberOfImages = 3
  assert.match(getImageModelGuidance('openai/gpt-image-2.5-sunburst', settings)!.output, /^3 output images per job/)
  assert.match(getImageModelGuidance('google/gemini-3.1-flash-image', settings)!.output, /^1 output image per job/)
  assert.match(getImageModelGuidance('openai/gpt-image-2')!.transparency, /not available.*in this app/)
  assert.match(imageControlHelp('bfl/flux-pro-1.1-ultra', 'imagePromptStrength')!, /does not select an area to edit/)
  assert.equal(imageControlHelp('bfl/flux-2-pro', 'imagePromptStrength'), undefined)
})
