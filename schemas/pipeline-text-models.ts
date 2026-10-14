import {z} from 'zod'

// Text-only outputs for pipeline utility steps; these are deliberately separate
// from the curated image-generator catalog and accept no arbitrary paid IDs.
export const LEGACY_PIPELINE_TEXT_MODEL_ID = 'google/gemini-2.5-flash' as const
export const PIPELINE_TEXT_MODEL_IDS = ['zai/glm-5.3-flash', 'openai/gpt-6-luna', LEGACY_PIPELINE_TEXT_MODEL_ID] as const
export const PipelineTextModelIdSchema = z.enum(PIPELINE_TEXT_MODEL_IDS)
export type PipelineTextModelId = z.infer<typeof PipelineTextModelIdSchema>
export type PipelineTextReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const PIPELINE_TEXT_MODEL_PROFILES: Record<PipelineTextModelId, {
    id: PipelineTextModelId; name: string; description: string; reasoningLevels: readonly PipelineTextReasoningEffort[];
    reasoningHelp: string; maxOutputTokens: number; maxImages: number; temperatureMax: number; supportsTransparentBackground: false
}> = {
    'zai/glm-5.3-flash': {
        id: 'zai/glm-5.3-flash', name: 'GLM 5.3 Flash',
        description: 'A low-cost multimodal model for expanding short prompts while checking optional reference pictures.',
        reasoningLevels: ['low', 'high', 'max'],
        reasoningHelp: 'Thinking is always enabled. Low suits simple rewrites; High or Max spends more time on detailed constraints. Reasoning tokens count toward the output cap and the confirmed bill.',
        maxOutputTokens: 16384, maxImages: 8, temperatureMax: 1, supportsTransparentBackground: false,
    },
    'openai/gpt-6-luna': {
        id: 'openai/gpt-6-luna', name: 'GPT-6 Luna',
        description: 'OpenAI’s efficient text-and-image reasoning model for focused prompt improvements.',
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        reasoningHelp: 'None gives a direct rewrite. Higher levels spend more time reasoning about your instructions and may cost more. Temperature is available only with None. Reasoning shares the output-token cap.',
        maxOutputTokens: 16384, maxImages: 8, temperatureMax: 2, supportsTransparentBackground: false,
    },
    'google/gemini-2.5-flash': {
        id: LEGACY_PIPELINE_TEXT_MODEL_ID, name: 'Gemini 2.5 Flash',
        description: 'The existing pipeline text model, retained for saved pipelines and exact replay.',
        reasoningLevels: ['none', 'low', 'medium', 'high'],
        reasoningHelp: 'None preserves the original fast rewrite. Low, Medium and High use fixed thinking budgets of 512, 1024 and 2048 tokens. Thinking shares the output cap and is billed.',
        maxOutputTokens: 4096, maxImages: 8, temperatureMax: 2, supportsTransparentBackground: false,
    },
}
const common = {
    systemPrompt: z.string().max(20_000).default(''),
    prompt: z.string().max(20_000).default(''),
}
export const LegacyPipelineTextConfigSchema = z.object({
    ...common,
    model: z.literal(LEGACY_PIPELINE_TEXT_MODEL_ID).default(LEGACY_PIPELINE_TEXT_MODEL_ID),
    temperature: z.number().min(0).max(2).default(0.5),
    maxOutputTokens: z.number().int().min(64).max(4096).default(1024),
}).strict()
export const GEMINI_ENHANCER_THINKING_BUDGETS = {none: 0, low: 512, medium: 1024, high: 2048} as const
const geminiEnhancer = LegacyPipelineTextConfigSchema.extend({
    // Do not materialize a new key in legacy definitions during a rolling
    // worker upgrade: an old strict parser must still accept these snapshots.
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
}).strict().superRefine((value, context) => {
    if (value.maxOutputTokens <= GEMINI_ENHANCER_THINKING_BUDGETS[value.reasoningEffort ?? 'none'])
        context.addIssue({code: 'custom', path: ['maxOutputTokens'], message: 'The output cap must leave tokens for the answer after the selected thinking budget.'})
})
const glmEnhancer = z.object({
    ...common, model: z.literal('zai/glm-5.3-flash'),
    reasoningEffort: z.enum(['low', 'high', 'max']).default('low'),
    temperature: z.number().min(0).max(1).default(1),
    maxOutputTokens: z.number().int().min(64).max(16384).default(4096),
}).strict()
const lunaEnhancer = z.object({
    ...common, model: z.literal('openai/gpt-6-luna'),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).default('low'),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(64).max(16384).default(4096),
}).strict().superRefine((value, context) => {
    if (value.reasoningEffort !== 'none' && value.temperature !== undefined)
        context.addIssue({code: 'custom', path: ['temperature'], message: 'GPT-6 Luna supports temperature only when reasoning is None.'})
})
export const PromptEnhancerConfigSchema = z.preprocess(value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !('model' in value))
        return {...value, model: LEGACY_PIPELINE_TEXT_MODEL_ID}
    return value
}, z.discriminatedUnion('model', [geminiEnhancer, glmEnhancer, lunaEnhancer]))
export type PromptEnhancerConfig = z.infer<typeof PromptEnhancerConfigSchema>
export type PipelineTextConfig = z.infer<typeof LegacyPipelineTextConfigSchema> | PromptEnhancerConfig
export type StoredPipelineTextConfig = PipelineTextConfig & {imageUrls: string[]}
export function createPromptEnhancerConfig(model: PipelineTextModelId): PromptEnhancerConfig {
    return PromptEnhancerConfigSchema.parse({model, ...(model === LEGACY_PIPELINE_TEXT_MODEL_ID ? {reasoningEffort: 'none'} : {})})
}
export function pipelineTextSupportsTemperature(config: PipelineTextConfig): boolean {
    return config.model !== 'openai/gpt-6-luna' || config.reasoningEffort === 'none'
}
export function pipelineTextProviderOptions(config: PipelineTextConfig): Record<string, Record<string, string | number | boolean | string[] | Record<string, string | number | boolean>>> {
    // Pin to the native serving provider so its exact reasoning controls cannot
    // be silently ignored by another provider during automatic routing.
    if (config.model === 'openai/gpt-6-luna') return {
        gateway: {only: ['openai']}, openai: {reasoningEffort: config.reasoningEffort},
    }
    if (config.model === 'zai/glm-5.3-flash') return {
        gateway: {only: ['zai']}, zai: {reasoningEffort: config.reasoningEffort, thinking: {type: 'enabled'}},
    }
    const effort = 'reasoningEffort' in config ? config.reasoningEffort ?? 'none' : 'none'
    const budget = GEMINI_ENHANCER_THINKING_BUDGETS[effort]
    return {...(effort === 'none' ? {} : {gateway: {only: ['google']}}),
        google: {thinkingConfig: {thinkingBudget: budget}, responseModalities: ['TEXT']}}
}
