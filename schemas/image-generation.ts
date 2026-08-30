import { z } from 'zod'

export const SUPPORTED_IMAGE_MODEL_IDS = [
  'google/gemini-3.1-flash-image',
  'google/gemini-3-pro-image',
  'google/gemini-3.1-flash-lite-image',
  'google/gemini-2.5-flash-image',
  'openai/gpt-image-2',
] as const

export const DEFAULT_IMAGE_MODEL_ID = 'google/gemini-3.1-flash-image' as const
export const ImageModelIdSchema = z.enum(SUPPORTED_IMAGE_MODEL_IDS)
export type ImageModelId = z.infer<typeof ImageModelIdSchema>

export const LEGACY_IMAGE_MODEL_ALIASES: Readonly<Record<string, ImageModelId>> = {
  'google/gemini-3.1-flash-image-preview': 'google/gemini-3.1-flash-image',
  'google/gemini-3-pro-image-preview': 'google/gemini-3-pro-image',
  'google/gemini-2.5-flash-image-preview': 'google/gemini-2.5-flash-image',
}

export const GEMINI_STANDARD_ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const

export const GEMINI_EXTREME_ASPECT_RATIOS = [
  '1:4', '1:8', '4:1', '8:1',
] as const

export const GEMINI_ALL_ASPECT_RATIOS = [
  ...GEMINI_STANDARD_ASPECT_RATIOS,
  ...GEMINI_EXTREME_ASPECT_RATIOS,
] as const

export const GeminiAspectRatioSchema = z.enum(GEMINI_ALL_ASPECT_RATIOS)
export type GeminiAspectRatio = z.infer<typeof GeminiAspectRatioSchema>

export const SafetyThresholdSchema = z.enum([
  'OFF',
  'BLOCK_NONE',
  'BLOCK_ONLY_HIGH',
  'BLOCK_MEDIUM_AND_ABOVE',
  'BLOCK_LOW_AND_ABOVE',
])
export type SafetyThreshold = z.infer<typeof SafetyThresholdSchema>

export const GeminiSafetySettingsSchema = z.object({
  hateSpeech: SafetyThresholdSchema.default('OFF'),
  dangerousContent: SafetyThresholdSchema.default('OFF'),
  harassment: SafetyThresholdSchema.default('OFF'),
  sexuallyExplicit: SafetyThresholdSchema.default('OFF'),
}).strict()
export type GeminiSafetySettings = z.infer<typeof GeminiSafetySettingsSchema>

const optionalFiniteNumber = (minimum: number, maximum: number) =>
  z.number().finite().min(minimum).max(maximum).optional()

const optionalInteger = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum).optional()

const GeminiSamplingSchema = z.object({
  temperature: optionalFiniteNumber(0, 2),
  topP: optionalFiniteNumber(0, 1),
  topK: optionalInteger(1, 1000),
  seed: z.number().int().min(-2147483648).max(2147483647).optional(),
  maxOutputTokens: optionalInteger(1, 32768),
}).strict()

const GeminiBaseSettingsSchema = z.object({
  aspectRatio: GeminiAspectRatioSchema.optional(),
  includeText: z.boolean().default(false),
  safety: GeminiSafetySettingsSchema.default({
    hateSpeech: 'OFF',
    dangerousContent: 'OFF',
    harassment: 'OFF',
    sexuallyExplicit: 'OFF',
  }),
  sampling: GeminiSamplingSchema.default({}),
}).strict()

export const Gemini31FlashImageSettingsSchema = GeminiBaseSettingsSchema.extend({
  kind: z.literal('gemini-3.1-flash-image'),
  imageSize: z.enum(['512', '1K', '2K', '4K']).default('1K'),
  thinkingLevel: z.enum(['minimal', 'high']).default('minimal'),
  includeThoughts: z.boolean().default(false),
  grounding: z.enum(['off', 'web', 'images', 'web-and-images']).default('off'),
}).strict()
export type Gemini31FlashImageSettings = z.infer<typeof Gemini31FlashImageSettingsSchema>

export const Gemini3ProImageSettingsSchema = GeminiBaseSettingsSchema.extend({
  kind: z.literal('gemini-3-pro-image'),
  aspectRatio: z.enum(GEMINI_STANDARD_ASPECT_RATIOS).optional(),
  imageSize: z.enum(['1K', '2K', '4K']).default('1K'),
  includeThoughts: z.boolean().default(false),
  grounding: z.enum(['off', 'web']).default('off'),
}).strict()
export type Gemini3ProImageSettings = z.infer<typeof Gemini3ProImageSettingsSchema>

export const Gemini31FlashLiteImageSettingsSchema = GeminiBaseSettingsSchema.extend({
  kind: z.literal('gemini-3.1-flash-lite-image'),
  imageSize: z.literal('1K').default('1K'),
  thinkingLevel: z.enum(['minimal', 'high']).default('minimal'),
  includeThoughts: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if ((value.sampling.maxOutputTokens ?? 0) > 4096) {
    context.addIssue({
      code: 'custom',
      path: ['sampling', 'maxOutputTokens'],
      message: 'Gemini 3.1 Flash Lite Image supports at most 4096 output tokens.',
    })
  }
})
export type Gemini31FlashLiteImageSettings = z.infer<typeof Gemini31FlashLiteImageSettingsSchema>

export const Gemini25FlashImageSettingsSchema = GeminiBaseSettingsSchema.extend({
  kind: z.literal('gemini-2.5-flash-image'),
  aspectRatio: z.enum(GEMINI_STANDARD_ASPECT_RATIOS).optional(),
}).strict()
export type Gemini25FlashImageSettings = z.infer<typeof Gemini25FlashImageSettingsSchema>

const GPT_IMAGE_2_MIN_PIXELS = 655_360
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400
const GPT_IMAGE_2_MAX_EDGE = 3840

export function isValidGptImage2Size(value: string): boolean {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(value)
  if (!match) return false
  const width = Number(match[1])
  const height = Number(match[2])
  const pixels = width * height
  const ratio = Math.max(width / height, height / width)
  return width % 16 === 0
    && height % 16 === 0
    && width <= GPT_IMAGE_2_MAX_EDGE
    && height <= GPT_IMAGE_2_MAX_EDGE
    && ratio <= 3
    && pixels >= GPT_IMAGE_2_MIN_PIXELS
    && pixels <= GPT_IMAGE_2_MAX_PIXELS
}

export const GptImage2SizeSchema = z.string()
  .trim()
  .refine(isValidGptImage2Size, {
    message: 'Use WIDTHxHEIGHT with edges divisible by 16, max 3840, ratio at most 3:1, and 655,360–8,294,400 pixels.',
  })

export const OpenAiGptImage2SettingsSchema = z.object({
  kind: z.literal('openai-gpt-image-2'),
  size: GptImage2SizeSchema.optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  background: z.enum(['auto', 'opaque']).default('auto'),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
  outputCompression: z.number().int().min(0).max(100).optional(),
  moderation: z.enum(['auto', 'low']).default('auto'),
  numberOfImages: z.number().int().min(1).max(10).default(1),
  user: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((value, context) => {
  if (value.outputFormat === 'png' && value.outputCompression != null) {
    context.addIssue({
      code: 'custom',
      path: ['outputCompression'],
      message: 'Output compression is only supported for JPEG and WebP.',
    })
  }
})
export type OpenAiGptImage2Settings = z.infer<typeof OpenAiGptImage2SettingsSchema>

export const ImageGenerationSettingsSchema = z.discriminatedUnion('kind', [
  Gemini31FlashImageSettingsSchema,
  Gemini3ProImageSettingsSchema,
  // Zod cannot place an effects schema inside a discriminated union, so the Lite
  // token ceiling is also checked by validateGenerationRequest below.
  GeminiBaseSettingsSchema.extend({
    kind: z.literal('gemini-3.1-flash-lite-image'),
    imageSize: z.literal('1K').default('1K'),
    thinkingLevel: z.enum(['minimal', 'high']).default('minimal'),
    includeThoughts: z.boolean().default(false),
  }).strict(),
  Gemini25FlashImageSettingsSchema,
  OpenAiGptImage2SettingsSchema,
])
export type ImageGenerationSettings = z.infer<typeof ImageGenerationSettingsSchema>
export type GeminiImageGenerationSettings = Exclude<ImageGenerationSettings, OpenAiGptImage2Settings>

// Google accounts for the image itself inside maxOutputTokens. Values below
// these documented per-tier costs cannot contain a complete requested image.
export function minimumGeminiImageTokens(settings: ImageGenerationSettings): number | undefined {
  switch (settings.kind) {
    case 'gemini-3.1-flash-image':
      return ({'512': 747, '1K': 1120, '2K': 1680, '4K': 2520} as const)[settings.imageSize]
    case 'gemini-3-pro-image':
      return settings.imageSize === '4K' ? 2000 : 1120
    case 'gemini-3.1-flash-lite-image':
      return 1120
    case 'gemini-2.5-flash-image':
      return 1290
    case 'openai-gpt-image-2':
      return undefined
  }
}

export const ImagePathSchema = z.string()
  .trim()
  .min(1)
  .max(1024)
  .refine(value => value.startsWith('/images/'), 'Image paths must be inside /images/.')
  .refine(value => !/(^|[/\\])\.\.([/\\]|$)/.test(value), 'Parent path segments are not allowed.')
  .refine(value => !/[\0\r\n]/.test(value), 'Invalid image path.')

export const StoredGenerationConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profileVersion: z.number().int().positive(),
  requestedModel: z.string().min(1),
  effectiveModel: ImageModelIdSchema,
  settings: ImageGenerationSettingsSchema,
  maskImage: ImagePathSchema.optional(),
  storeInputImages: z.boolean(),
}).strict()
export type StoredGenerationConfig = z.infer<typeof StoredGenerationConfigSchema>

export const OutputMetadataSchema = z.object({
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  responseText: z.string().optional(),
  reasoningText: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  grounding: z.object({
    sources: z.array(z.object({
      url: z.string().url(),
      title: z.string().optional(),
    }).strict()).max(50).default([]),
    searchEntryPointHtml: z.string().max(100_000).optional(),
  }).strict().optional(),
}).strict()
export type OutputMetadata = z.infer<typeof OutputMetadataSchema>

export const StoredGenerationErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string().min(1),
  statusCode: z.number().int().optional(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
}).strict()
export type StoredGenerationError = z.infer<typeof StoredGenerationErrorSchema>

export const ImageGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(1, 'Prompt is required.').max(20_000),
  model: ImageModelIdSchema,
  inputImages: z.array(ImagePathSchema).max(20).default([]),
  modelImages: z.array(ImagePathSchema).max(16).default([]),
  maskImage: ImagePathSchema.optional(),
  storeInputImages: z.boolean().default(true),
  parentSystemPromptId: z.number().int().positive().optional(),
  settings: ImageGenerationSettingsSchema,
}).strict().superRefine((value, context) => {
  const expectedKind = value.model === 'openai/gpt-image-2'
    ? 'openai-gpt-image-2'
    : value.model.slice('google/'.length)
  if (value.settings.kind !== expectedKind) {
    context.addIssue({
      code: 'custom',
      path: ['settings', 'kind'],
      message: `Settings kind ${value.settings.kind} does not belong to model ${value.model}.`,
    })
  }

  const sourcesPerJob = (value.inputImages.length > 0 ? 1 : 0) + value.modelImages.length
  const maximumReferences = value.model === 'openai/gpt-image-2'
    ? 16
    : value.model === 'google/gemini-2.5-flash-image'
      ? 16
      : 14
  if (sourcesPerJob > maximumReferences) {
    context.addIssue({
      code: 'custom',
      path: ['modelImages'],
      message: `${value.model} supports at most ${maximumReferences} reference images per generation.`,
    })
  }

  if (value.maskImage && value.model !== 'openai/gpt-image-2') {
    context.addIssue({
      code: 'custom',
      path: ['maskImage'],
      message: 'Masks are only supported by GPT Image 2.',
    })
  }
  if (value.maskImage && value.inputImages.length === 0 && value.modelImages.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['maskImage'],
      message: 'A mask requires at least one source image.',
    })
  }

  const outputsPerJob = value.settings.kind === 'openai-gpt-image-2'
    ? value.settings.numberOfImages
    : 1
  const providerJobs = Math.max(1, value.inputImages.length)
  if (providerJobs * outputsPerJob > 50) {
    context.addIssue({
      code: 'custom',
      path: ['settings'],
      message: 'A request may create at most 50 output images.',
    })
  }

  if (value.settings.kind === 'gemini-3.1-flash-lite-image'
    && (value.settings.sampling.maxOutputTokens ?? 0) > 4096) {
    context.addIssue({
      code: 'custom',
      path: ['settings', 'sampling', 'maxOutputTokens'],
      message: 'Gemini 3.1 Flash Lite Image supports at most 4096 output tokens.',
    })
  }

  if (value.settings.kind !== 'openai-gpt-image-2') {
    const minimum = minimumGeminiImageTokens(value.settings)
    const requestedMaximum = value.settings.sampling.maxOutputTokens
    if (minimum != null && requestedMaximum != null && requestedMaximum < minimum) {
      context.addIssue({
        code: 'custom',
        path: ['settings', 'sampling', 'maxOutputTokens'],
        message: `This image tier requires at least ${minimum} output tokens before any returned text or thought summary.`,
      })
    }
  }
})
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>

export type ImageModelProfile = {
  id: ImageModelId
  profileVersion: number
  name: string
  shortName: string
  provider: 'google' | 'openai'
  adapter: 'gateway-language-image' | 'gateway-image'
  settingsComponent: 'Gemini31FlashImageSettings'
    | 'Gemini3ProImageSettings'
    | 'Gemini31FlashLiteImageSettings'
    | 'Gemini25FlashImageSettings'
    | 'OpenAiGptImage2Settings'
  lifecycle: 'recommended' | 'current' | 'legacy'
  lifecycleNote?: string
  description: string
  maxReferenceImages: number
  referenceInputs: readonly ['image']
  supportsMask: boolean
  supportsTextOutput: boolean
  aspectRatios: readonly GeminiAspectRatio[]
  imageSizes: readonly string[]
  warnings: readonly string[]
}

export const IMAGE_MODEL_PROFILES: Readonly<Record<ImageModelId, ImageModelProfile>> = {
  'google/gemini-3.1-flash-image': {
    id: 'google/gemini-3.1-flash-image',
    profileVersion: 1,
    name: 'Gemini 3.1 Flash Image',
    shortName: 'Gemini 3.1 Flash',
    provider: 'google',
    adapter: 'gateway-language-image',
    settingsComponent: 'Gemini31FlashImageSettings',
    lifecycle: 'recommended',
    description: 'Best general-purpose Gemini image model; supports 512–4K, thinking, and web/image grounding.',
    maxReferenceImages: 14,
    referenceInputs: ['image'],
    supportsMask: false,
    supportsTextOutput: true,
    aspectRatios: GEMINI_ALL_ASPECT_RATIOS,
    imageSizes: ['512', '1K', '2K', '4K'],
    warnings: [
      'Reference inputs are image files only; this product does not accept PDF, video, audio, or other media.',
      '4K output may still be preview-level even though the model ID is GA.',
      'Reference fidelity guidance: up to 10 object references and 4 character references (14 total).',
      'Google Image Search grounding cannot use real-world images of people.',
      'All generated images include SynthID.',
    ],
  },
  'google/gemini-3-pro-image': {
    id: 'google/gemini-3-pro-image',
    profileVersion: 1,
    name: 'Gemini 3 Pro Image',
    shortName: 'Gemini 3 Pro',
    provider: 'google',
    adapter: 'gateway-language-image',
    settingsComponent: 'Gemini3ProImageSettings',
    lifecycle: 'current',
    description: 'Premium Gemini model for complex professional assets, text rendering, and high-fidelity edits.',
    maxReferenceImages: 14,
    referenceInputs: ['image'],
    supportsMask: false,
    supportsTextOutput: true,
    aspectRatios: GEMINI_STANDARD_ASPECT_RATIOS,
    imageSizes: ['1K', '2K', '4K'],
    warnings: [
      'Reference inputs are image files only; this product does not accept PDF, video, audio, or other media.',
      'Reference fidelity guidance: up to 6 object, 5 character, and 3 style references (14 total).',
      'Thinking is always enabled and its level is not configurable for this image model.',
      'All generated images include SynthID.',
    ],
  },
  'google/gemini-3.1-flash-lite-image': {
    id: 'google/gemini-3.1-flash-lite-image',
    profileVersion: 1,
    name: 'Gemini 3.1 Flash Lite Image',
    shortName: 'Gemini 3.1 Flash Lite',
    provider: 'google',
    adapter: 'gateway-language-image',
    settingsComponent: 'Gemini31FlashLiteImageSettings',
    lifecycle: 'current',
    description: 'Lowest-latency, low-cost Gemini image generation and editing; fixed to 1K output.',
    maxReferenceImages: 14,
    referenceInputs: ['image'],
    supportsMask: false,
    supportsTextOutput: true,
    aspectRatios: GEMINI_ALL_ASPECT_RATIOS,
    imageSizes: ['1K'],
    warnings: [
      'Reference inputs are image files only; this product does not accept PDF, video, audio, or other media.',
      'Supports up to 14 object references; this model does not define separate character or style-reference buckets.',
      'Google Search grounding is not supported.',
      'This model is less suited to complex multi-reference or multi-turn work.',
      'All generated images include SynthID and C2PA metadata.',
    ],
  },
  'google/gemini-2.5-flash-image': {
    id: 'google/gemini-2.5-flash-image',
    profileVersion: 1,
    name: 'Gemini 2.5 Flash Image',
    shortName: 'Gemini 2.5 Flash (legacy)',
    provider: 'google',
    adapter: 'gateway-language-image',
    settingsComponent: 'Gemini25FlashImageSettings',
    lifecycle: 'legacy',
    lifecycleNote: 'Scheduled to retire October 2, 2026. Prefer Gemini 3.1 Flash Lite or Flash.',
    description: 'Legacy 1024-class Gemini model retained for comparison and reproducibility.',
    maxReferenceImages: 16,
    referenceInputs: ['image'],
    supportsMask: false,
    supportsTextOutput: true,
    aspectRatios: GEMINI_STANDARD_ASPECT_RATIOS,
    imageSizes: ['1K'],
    warnings: [
      'Reference inputs are image files only; this product does not accept PDF, video, audio, or other media.',
      'Thinking controls and Search grounding are not supported.',
      'Quality is best with at most three reference images; this is guidance, not a documented API hard limit.',
      'All generated images include SynthID.',
    ],
  },
  'openai/gpt-image-2': {
    id: 'openai/gpt-image-2',
    profileVersion: 1,
    name: 'GPT Image 2',
    shortName: 'GPT Image 2',
    provider: 'openai',
    adapter: 'gateway-image',
    settingsComponent: 'OpenAiGptImage2Settings',
    lifecycle: 'current',
    description: 'OpenAI’s current image generation/editing model with custom dimensions, masks, and up to ten outputs.',
    maxReferenceImages: 16,
    referenceInputs: ['image'],
    supportsMask: true,
    supportsTextOutput: false,
    aspectRatios: [],
    imageSizes: [],
    warnings: [
      'Reference inputs are image files only; this product does not accept PDF, video, audio, or other media.',
      'Input fidelity is always high and cannot be changed.',
      'Transparent backgrounds, seed, style, and a separate aspect-ratio option are not supported.',
      'Dimensions above roughly 2K should be treated as experimental through Gateway until verified.',
    ],
  },
}

export function getImageModelProfile(model: string): ImageModelProfile | undefined {
  const canonical = LEGACY_IMAGE_MODEL_ALIASES[model] ?? model
  return IMAGE_MODEL_PROFILES[canonical as ImageModelId]
}

export function canonicalizeImageModelId(model: string | undefined | null): string {
  if (!model) return DEFAULT_IMAGE_MODEL_ID
  return LEGACY_IMAGE_MODEL_ALIASES[model] ?? model
}

export function createDefaultSettings(model: ImageModelId): ImageGenerationSettings {
  switch (model) {
    case 'google/gemini-3.1-flash-image':
      return Gemini31FlashImageSettingsSchema.parse({kind: 'gemini-3.1-flash-image'})
    case 'google/gemini-3-pro-image':
      return Gemini3ProImageSettingsSchema.parse({kind: 'gemini-3-pro-image'})
    case 'google/gemini-3.1-flash-lite-image':
      return Gemini31FlashLiteImageSettingsSchema.parse({kind: 'gemini-3.1-flash-lite-image'})
    case 'google/gemini-2.5-flash-image':
      return Gemini25FlashImageSettingsSchema.parse({kind: 'gemini-2.5-flash-image'})
    case 'openai/gpt-image-2':
      return OpenAiGptImage2SettingsSchema.parse({kind: 'openai-gpt-image-2'})
  }
}
