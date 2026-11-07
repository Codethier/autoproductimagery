import assert from 'node:assert/strict'
import test from 'node:test'
import {createPipelineNode, PipelineNodeSchema, PipelineDefinitionSchema} from '../schemas/pipelines.ts'
import {
    PIPELINE_TEXT_MODEL_IDS, PIPELINE_TEXT_MODEL_PROFILES, PromptEnhancerConfigSchema,
    createPromptEnhancerConfig, pipelineTextProviderOptions, pipelineTextSupportsTemperature,
} from '../schemas/pipeline-text-models.ts'

test('enhancer text models are exact allowlisted profiles with explicit native effort choices', () => {
    assert.deepEqual(PIPELINE_TEXT_MODEL_IDS, ['zai/glm-5.3-flash', 'openai/gpt-6-luna', 'google/gemini-2.5-flash'])
    for (const id of PIPELINE_TEXT_MODEL_IDS) {
        const value = createPromptEnhancerConfig(id), profile = PIPELINE_TEXT_MODEL_PROFILES[id]
        assert.equal(value.model, id)
        assert.equal(profile.supportsTransparentBackground, false)
        assert.equal(profile.maxImages, 8)
        assert.ok(profile.reasoningLevels.includes(value.reasoningEffort ?? 'none'))
        for (const effort of profile.reasoningLevels) assert.equal(PromptEnhancerConfigSchema.safeParse({
            ...value, reasoningEffort: effort, maxOutputTokens: profile.maxOutputTokens,
        }).success, true)
    }
    const old = createPipelineNode('prompt-enhancer', 'enhance')
    assert.equal(old.config.model, 'google/gemini-2.5-flash')
    assert.equal(old.config.reasoningEffort, undefined)
    assert.equal('reasoningEffort' in old.config, false)
    assert.deepEqual(pipelineTextProviderOptions(old.config), {google: {thinkingConfig: {thinkingBudget: 0}, responseModalities: ['TEXT']}})
})

test('text configuration rejects unsupported efforts, arbitrary models and provider payloads', () => {
    const invalid = [
        {model: 'openai/gpt-6-luna', reasoningEffort: 'minimal'},
        {model: 'openai/gpt-6-luna', reasoningEffort: 'high', temperature: 0.2},
        {model: 'zai/glm-5.3-flash', reasoningEffort: 'none'},
        {model: 'zai/glm-5.3-flash', reasoningEffort: 'medium'},
        {model: 'zai/glm-5.3-flash', temperature: 1.1},
        {model: 'google/gemini-2.5-flash', reasoningEffort: 'max'},
        {model: 'google/gemini-2.5-flash', reasoningEffort: 'high', maxOutputTokens: 1024},
        {model: 'google/gemini-2.5-flash', maxOutputTokens: 4097},
        {model: 'openai/gpt-image-2'},
        {model: 'openai/gpt-6-sol'},
        {model: 'zai/glm-5.3-flash', providerOptions: {gateway: {models: ['expensive/model']}}},
        {model: 'openai/gpt-6-luna', tools: {search: true}},
        {model: 'openai/gpt-6-luna', maxOutputTokens: 16385},
    ]
    for (const config of invalid) assert.equal(PromptEnhancerConfigSchema.safeParse(config).success, false, JSON.stringify(config))
    const luna = PromptEnhancerConfigSchema.parse({model: 'openai/gpt-6-luna', reasoningEffort: 'none', temperature: 0.3})
    assert.equal(pipelineTextSupportsTemperature(luna), true)
    assert.equal(pipelineTextSupportsTemperature(createPromptEnhancerConfig('openai/gpt-6-luna')), false)
})

test('native text adapters preserve the exact effort and restrict incompatible provider routing', () => {
    assert.deepEqual(pipelineTextProviderOptions(PromptEnhancerConfigSchema.parse({model: 'zai/glm-5.3-flash', reasoningEffort: 'max'})),
        {gateway: {only: ['zai']}, zai: {reasoningEffort: 'max', thinking: {type: 'enabled'}}})
    assert.deepEqual(pipelineTextProviderOptions(PromptEnhancerConfigSchema.parse({model: 'openai/gpt-6-luna', reasoningEffort: 'xhigh'})),
        {gateway: {only: ['openai']}, openai: {reasoningEffort: 'xhigh'}})
    assert.deepEqual(pipelineTextProviderOptions(PromptEnhancerConfigSchema.parse({model: 'google/gemini-2.5-flash', reasoningEffort: 'high', maxOutputTokens: 4096})),
        {gateway: {only: ['google']}, google: {thinkingConfig: {thinkingBudget: 2048}, responseModalities: ['TEXT']}})
})

test('old Gemini snapshots stay runnable and new saved enhancer settings round-trip without model inference', () => {
    const old = createPipelineNode('prompt-enhancer', 'enhance')
    const legacy = {...old, config: {model: 'google/gemini-2.5-flash', prompt: 'A red bag', systemPrompt: '', temperature: 0.2, maxOutputTokens: 512}}
    const parsed = PipelineNodeSchema.parse(legacy)
    assert.equal(parsed.type === 'prompt-enhancer' && parsed.config.reasoningEffort, undefined)
    assert.deepEqual(parsed.config, legacy.config, 'Old strict workers must accept unchanged legacy settings during rollout')
    for (const model of PIPELINE_TEXT_MODEL_IDS) {
        const node = {...old, config: {...createPromptEnhancerConfig(model), prompt: 'Preserve the green label', systemPrompt: 'Return only the prompt.'}}
        const graph = PipelineDefinitionSchema.parse({version: 1, nodes: [node], edges: []})
        assert.deepEqual(PipelineDefinitionSchema.parse(JSON.parse(JSON.stringify(graph))), graph)
    }
    for (const type of ['llm', 'describe-image'] as const)
        assert.equal(PipelineNodeSchema.safeParse({...createPipelineNode(type, 'text'), config: createPromptEnhancerConfig('openai/gpt-6-luna')}).success, false)
})
