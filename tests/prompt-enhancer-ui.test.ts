import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createRenderer, createSSRApp, h, nextTick, ref} from 'vue'
import {createPipelineNode, type PipelineNode} from '../schemas/pipelines.ts'
import {PIPELINE_TEXT_MODEL_IDS, PromptEnhancerConfigSchema} from '../schemas/pipeline-text-models.ts'

const root = new URL('../', import.meta.url)
const properties = new URL('app/components/PipelineNodeProperties.vue', root).href
const favourites = new URL('app/composables/useImageModelFavourites.ts', root).href
registerHooks({load(url, context, next) {
    if (url === favourites) return {format: 'module', shortCircuit: true,
        source: `import {computed,ref} from 'vue';export const useImageModelFavourites=()=>({favouriteModelIds:ref([]),favouriteSet:computed(()=>new Set()),ready:ref(true),toggleFavourite(){}});`}
    if (url.startsWith(new URL('app/components/generation-settings/', root).href) && url.endsWith('.vue'))
        return {format: 'module', shortCircuit: true, source: 'export default {setup:()=>()=>null};'}
    if (url === properties) {
        const filename = fileURLToPath(url), {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
        const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
        return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed,ref,watch} from 'vue';${compiled.content}`)}
    }
    return next(url, context)
}})
type MemoryNode = {tag: string; text: string; children: MemoryNode[]; parent: MemoryNode | null; props: Record<string, any>}
const memoryNode = (tag: string, text = ''): MemoryNode => ({tag, text, children: [], parent: null, props: {}})
const renderer = createRenderer<MemoryNode, MemoryNode>({
    createElement: tag => memoryNode(tag), createText: text => memoryNode('#text', text), createComment: text => memoryNode('#comment', text),
    insert(value, parent, anchor) {
        if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1)
        const index = anchor ? parent.children.indexOf(anchor) : -1
        if (index < 0) parent.children.push(value); else parent.children.splice(index, 0, value)
        value.parent = parent
    },
    remove(value) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); value.parent = null},
    setText(value, text) {value.text = text}, setElementText(value, text) {value.text = text; value.children = []},
    parentNode: value => value.parent, nextSibling: value => value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null,
    patchProp(value, name, _before, after) {value.props[name] = after},
})
function registerComponents(app: any) {
    app.component('UIcon', {props: ['name'], setup: (props: any) => () => h('span', {'data-icon': props.name})})
    app.component('NuxtErrorBoundary', {setup: (_props: unknown, {slots}: any) => () => slots.default?.()})
    app.component('ModelGuidance', {setup: () => () => null})
}
const elements = (value: MemoryNode): MemoryNode[] => [value, ...value.children.flatMap(elements)]
const renderedText = (value: MemoryNode): string => value.text + value.children.map(renderedText).join('')
function field(value: MemoryNode, id: string) {
    const result = elements(value).find(child => child.props.id === id)
    assert.ok(result, `Expected field ${id}`); return result
}
async function mount(node: PipelineNode, disabled = false) {
    const {default: component} = await import(properties)
    const selected = ref(node), events: PipelineNode[] = []
    const app = renderer.createApp({render: () => h(component, {node: selected.value,
        definition: {version: 1, nodes: [selected.value], edges: []}, models: [], disabled,
        onUpdate(value: PipelineNode) {events.push(value); selected.value = value}})})
    registerComponents(app)
    const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
    const tree = memoryNode('root'); app.mount(tree); await nextTick(); assert.deepEqual(warnings, [])
    return {app, tree, selected, events}
}
test('the actual enhancer inspector offers explicit text models and explains attention, usage and output', async t => {
    const value = await mount(createPipelineNode('prompt-enhancer', 'enhance')); t.after(() => value.app.unmount())
    assert.deepEqual(field(value.tree, 'pipeline-enhancer-model').children.filter(option => option.tag === 'option').map(option => option.props.value), [...PIPELINE_TEXT_MODEL_IDS])
    assert.match(renderedText(value.tree), /Reasoning effort \(attention level\)/)
    assert.match(renderedText(value.tree), /connect their output to an image generator’s Prompt input/)
    assert.match(renderedText(value.tree), /Gateway confirms them/)
    field(value.tree, 'pipeline-enhancer-model').props.onChange({target: {value: 'zai/glm-5.3-flash'}})
    await nextTick()
    assert.deepEqual(field(value.tree, 'pipeline-enhancer-reasoning').children.filter(option => option.tag === 'option').map(option => option.props.value), ['low', 'high', 'max'])
    assert.match(renderedText(value.tree), /Thinking is always enabled/)
    assert.equal(field(value.tree, 'pipeline-temperature').props.max, 1)
    assert.equal(field(value.tree, 'pipeline-text-tokens').props.max, 16384)
})
test('switching enhancer models resets incompatible settings synchronously while retaining user instructions', async t => {
    const node = createPipelineNode('prompt-enhancer', 'enhance')
    node.config.prompt = 'Keep the label green'; node.config.systemPrompt = 'Return just the prompt'
    const value = await mount(node); t.after(() => value.app.unmount())
    const select = field(value.tree, 'pipeline-enhancer-model')
    select.props.onChange({target: {value: 'zai/glm-5.3-flash'}})
    // A rapid second event arrives before parent props/rendering update.
    field(value.tree, 'pipeline-enhancer-reasoning').props.onChange({target: {value: 'max'}})
    const glm = value.events.at(-1)!
    assert.equal(glm.type === 'prompt-enhancer' && glm.config.model, 'zai/glm-5.3-flash')
    assert.equal(glm.type === 'prompt-enhancer' && glm.config.reasoningEffort, 'max')
    select.props.onChange({target: {value: 'openai/gpt-6-luna'}})
    await nextTick()
    const luna = value.selected.value
    assert.equal(luna.type === 'prompt-enhancer' && luna.config.reasoningEffort, 'low')
    assert.equal('temperature' in luna.config, false)
    assert.equal(elements(value.tree).some(child => child.props.id === 'pipeline-temperature'), false)
    field(value.tree, 'pipeline-enhancer-reasoning').props.onChange({target: {value: 'none'}})
    await nextTick()
    assert.equal(field(value.tree, 'pipeline-temperature').props.value, 0.5)
    field(value.tree, 'pipeline-enhancer-reasoning').props.onChange({target: {value: 'xhigh'}})
    await nextTick()
    assert.equal('temperature' in value.selected.value.config, false)
    select.props.onChange({target: {value: 'google/gemini-2.5-flash'}})
    await nextTick()
    const restored = value.selected.value
    assert.equal(restored.type === 'prompt-enhancer' && restored.config.reasoningEffort, 'none')
    assert.equal(restored.type === 'prompt-enhancer' && restored.config.prompt, node.config.prompt)
    assert.equal(restored.type === 'prompt-enhancer' && restored.config.systemPrompt, node.config.systemPrompt)
    field(value.tree, 'pipeline-enhancer-reasoning').props.onChange({target: {value: 'high'}})
    assert.ok(value.selected.value.type === 'prompt-enhancer' && value.selected.value.config.maxOutputTokens >= 2112)
    assert.equal(PromptEnhancerConfigSchema.safeParse(value.selected.value.config).success, true)
})
test('disabled enhancer handlers do not change stored settings and unrelated text utilities stay on Gemini', async t => {
    const value = await mount(createPipelineNode('prompt-enhancer', 'enhance'), true); t.after(() => value.app.unmount())
    field(value.tree, 'pipeline-enhancer-model').props.onChange({target: {value: 'openai/gpt-6-luna'}})
    field(value.tree, 'pipeline-enhancer-reasoning').props.onChange({target: {value: 'high'}})
    assert.equal(value.events.length, 0)
    const {default: component} = await import(properties)
    for (const type of ['llm', 'describe-image'] as const) {
        const node = createPipelineNode(type, 'text')
        const app = createSSRApp({render: () => h(component, {node, definition: {version: 1, nodes: [node], edges: []}, models: []})})
        registerComponents(app); const html = await renderToString(app)
        assert.match(html, /Gemini 2.5 Flash through AI Gateway/)
        assert.doesNotMatch(html, /pipeline-enhancer-model|attention level/)
    }
})
