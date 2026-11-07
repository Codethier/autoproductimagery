import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createSSRApp, h} from 'vue'
import {transpileModule, ModuleKind, ScriptTarget} from 'typescript'
import {imageDownloadUrl, imagePreviewUrl} from '../app/utils/imageDelivery.ts'

test('image delivery preserves canonical Unicode encoding and uses bounded previews', () => {
  const stored = '/images/users/alice/Caf%C3%A9%20products/%E7%95%AB%E5%83%8F.png'
  assert.equal(imageDownloadUrl(stored), `/api/data${stored}`)
  for (const size of [160, 480, 960, 1600] as const) {
    assert.equal(imagePreviewUrl(stored, size), `/api/data${stored}?preview=${size}`)
  }
  assert.equal(imagePreviewUrl('images/products/original.png'), '/api/data/images/products/original.png?preview=480')
})

test('passing an existing preview never turns the download into a reduced image', () => {
  assert.equal(imageDownloadUrl('/api/data/images/result.png?preview=160'), '/api/data/images/result.png')
  assert.equal(imagePreviewUrl('/api/data/images/result.png?preview=160', 960), '/api/data/images/result.png?preview=960')
  assert.equal(imageDownloadUrl('/api/data/images/result.png?download=1&preview=160#image'), '/api/data/images/result.png?download=1#image')
  assert.equal(imagePreviewUrl('/api/data/images/result.png?download=1', 480), '/api/data/images/result.png?download=1&preview=480')
})

test('local data and object URLs remain unchanged rather than becoming stored-image requests', () => {
  for (const source of ['', 'data:image/png;base64,dGVzdA==', 'blob:http://localhost:3220/local-image', 'https://example.com/image.png', '/api/other-preview']) {
    assert.equal(imageDownloadUrl(source), source)
    assert.equal(imagePreviewUrl(source, 160), source)
  }
})

test('unsupported and protocol-relative URL schemes cannot become image downloads', () => {
  for (const source of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'file:///private/image.png', '//example.com/image.png']) {
    assert.equal(imageDownloadUrl(source), '')
    assert.equal(imagePreviewUrl(source, 480), '')
  }
})

async function compileDownloadableImage() {
  const source = readFileSync(new URL('../app/components/DownloadableImage.vue', import.meta.url), 'utf8')
    .replace('</script>', 'defineExpose({downloadImage});\n</script>')
  const {descriptor} = parse(source)
  const compiled = compileScript(descriptor, {id: 'image-delivery-client-test', inlineTemplate: true})
  const vueUrl = new URL('../node_modules/vue/index.mjs', import.meta.url).href
  const helperUrl = new URL('../app/utils/imageDelivery.ts', import.meta.url).href
  const resolved = compiled.content
    .replace(/(['"])vue\1/g, JSON.stringify(vueUrl))
    .replace(/(['"])\.\.\/utils\/imageDelivery\1/g, JSON.stringify(helperUrl))
  const javascript = transpileModule(resolved, {
    compilerOptions: {module: ModuleKind.ESNext, target: ScriptTarget.ES2022},
  }).outputText
  return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)).default
}

test('the real downloadable component displays a preview and downloads the original', async () => {
  const component = await compileDownloadableImage()
  const downloads: Array<{href: string; download: string}> = []
  const emitted: string[] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let bindings: {downloadImage: () => Promise<void>} | undefined
  const tested = {...component, setup(props: unknown, context: any) {
    return component.setup(props, {...context, expose(value: typeof bindings) {bindings = value}})
  }}
  const anchor = {href: '', download: '', rel: '', target: '', click() {downloads.push({href: this.href, download: this.download})}}
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {location: {href: 'http://localhost:3220/edit', origin: 'http://localhost:3220'}}})
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => anchor, body: {appendChild() {}, removeChild() {}}}})
  try {
    const stored = '/images/users/alice/Caf%C3%A9.png'
    const app = createSSRApp({render: () => h(tested, {src: stored, alt: 'Product', previewSize: 160, onDownload: (name: string) => emitted.push(name)})})
    app.component('UIcon', {setup: () => () => h('span')})
    const html = await renderToString(app)
    assert.match(html, /src="\/api\/data\/images\/users\/alice\/Caf%C3%A9.png\?preview=160"/)
    assert.match(html, /loading="lazy"/)
    assert.match(html, /decoding="async"/)
    await bindings!.downloadImage()
    assert.deepEqual(downloads, [{href: `/api/data${stored}`, download: 'Café.png'}])
    assert.deepEqual(emitted, ['Café.png'])
    const unsafe = createSSRApp({render: () => h(tested, {src: 'javascript:alert(1)', onDownload: (name: string) => emitted.push(name)})})
    unsafe.component('UIcon', {setup: () => () => h('span')})
    await renderToString(unsafe)
    await bindings!.downloadImage()
    assert.equal(downloads.length, 1, 'rejected sources never trigger the direct-download fallback')
    assert.deepEqual(emitted, ['Café.png'])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
