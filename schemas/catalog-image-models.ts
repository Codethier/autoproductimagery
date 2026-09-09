import { z } from 'zod'

// Audited 2026-09-09. Each exact ID has a strict schema and its own controls.
// https://ai-sdk.dev/providers/ai-sdk-providers/black-forest-labs
// https://docs.bfl.ai/flux_2/flux2_overview
// https://ai-sdk.dev/providers/ai-sdk-providers/bytedance
// https://ai-sdk.dev/providers/ai-sdk-providers/xai
// https://vercel.com/ai-gateway/models/muse-image-1.0
export const CATALOG_IMAGE_MODEL_IDS = [
  'bfl/flux-2-flex',
  'bfl/flux-2-klein-4b',
  'bfl/flux-2-klein-9b',
  'bfl/flux-2-max',
  'bfl/flux-2-pro',
  'bfl/flux-kontext-max',
  'bfl/flux-kontext-pro',
  'bfl/flux-pro-1.0-fill',
  'bfl/flux-pro-1.1',
  'bfl/flux-pro-1.1-ultra',
  'bytedance/seedream-4.0',
  'bytedance/seedream-4.5',
  'bytedance/seedream-5.0-lite',
  'bytedance/seedream-5.0-pro',
  'meta/muse-image-1.0',
  'spacexai/grok-imagine-image',
  'spacexai/grok-imagine-image-2.0',
] as const
export type CatalogImageModelId = typeof CATALOG_IMAGE_MODEL_IDS[number]

const seed = z.number().int().min(0).max(2147483647).optional()
const FLUX_SIZES = ['1024x1024', '1536x1024', '1024x1536', '2048x2048'] as const
const FLUX_11_SIZES = ['1024x1024', '1440x1024', '1024x1440'] as const
const FLUX_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'] as const
const GROK_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20'] as const
const BflBase = z.object({seed, outputFormat: z.enum(['png', 'jpeg']).default('png'), numberOfImages: z.literal(1).default(1)}).strict()
const Flux2Base = BflBase.extend({size: z.enum(FLUX_SIZES).optional()})
const KontextBase = BflBase.extend({aspectRatio: z.enum(FLUX_RATIOS).optional()})
const FillBase = BflBase
const Flux11Base = BflBase.extend({size: z.enum(FLUX_11_SIZES).optional()})
const UltraBase = BflBase.extend({aspectRatio: z.enum(FLUX_RATIOS).optional(), imagePromptStrength: z.number().min(0).max(1).default(0.1)})
const SeedreamBase = z.object({numberOfImages: z.literal(1).default(1), watermark: z.boolean().default(true)}).strict()
const MuseBase = z.object({numberOfImages: z.literal(1).default(1)}).strict()
const GrokBase = z.object({aspectRatio: z.enum(GROK_RATIOS).optional(), numberOfImages: z.number().int().min(1).max(10).default(1)}).strict()

export const Flux2FlexSettingsSchema = Flux2Base.extend({
  kind: z.literal('bfl/flux-2-flex'),
})

export const Flux2Klein4bSettingsSchema = Flux2Base.extend({
  kind: z.literal('bfl/flux-2-klein-4b'),
})

export const Flux2Klein9bSettingsSchema = Flux2Base.extend({
  kind: z.literal('bfl/flux-2-klein-9b'),
})

export const Flux2MaxSettingsSchema = Flux2Base.extend({
  kind: z.literal('bfl/flux-2-max'),
})

export const Flux2ProSettingsSchema = Flux2Base.extend({
  kind: z.literal('bfl/flux-2-pro'),
})

export const FluxKontextMaxSettingsSchema = KontextBase.extend({
  kind: z.literal('bfl/flux-kontext-max'),
})

export const FluxKontextProSettingsSchema = KontextBase.extend({
  kind: z.literal('bfl/flux-kontext-pro'),
})

export const FluxFillSettingsSchema = FillBase.extend({
  kind: z.literal('bfl/flux-pro-1.0-fill'),
})

export const Flux11ProSettingsSchema = Flux11Base.extend({
  kind: z.literal('bfl/flux-pro-1.1'),
})

export const Flux11UltraSettingsSchema = UltraBase.extend({
  kind: z.literal('bfl/flux-pro-1.1-ultra'),
})

export const Seedream40SettingsSchema = SeedreamBase.extend({
  kind: z.literal('bytedance/seedream-4.0'),
  resolution: z.enum(["1K","2K","4K"]).default('2K'),
  outputFormat: z.enum(["jpeg"]).default('jpeg'),
})

export const Seedream45SettingsSchema = SeedreamBase.extend({
  kind: z.literal('bytedance/seedream-4.5'),
  resolution: z.enum(["2K","4K"]).default('2K'),
  outputFormat: z.enum(["jpeg"]).default('jpeg'),
})

export const Seedream50LiteSettingsSchema = SeedreamBase.extend({
  kind: z.literal('bytedance/seedream-5.0-lite'),
  resolution: z.enum(["2K","3K","4K"]).default('2K'),
  outputFormat: z.enum(["png","jpeg"]).default('png'),
})

export const Seedream50ProSettingsSchema = SeedreamBase.extend({
  kind: z.literal('bytedance/seedream-5.0-pro'),
  resolution: z.enum(["1K","2K"]).default('2K'),
  outputFormat: z.enum(["png","jpeg"]).default('png'),
})

export const MuseImageSettingsSchema = MuseBase.extend({
  kind: z.literal('meta/muse-image-1.0'),
})

export const GrokImageSettingsSchema = GrokBase.extend({
  kind: z.literal('spacexai/grok-imagine-image'),
})

export const GrokImage20SettingsSchema = GrokBase.extend({
  kind: z.literal('spacexai/grok-imagine-image-2.0'),
  resolution: z.enum(['1k', '2k']).default('1k'),
})

export const CatalogImageSettingsSchema = z.discriminatedUnion('kind', [
  Flux2FlexSettingsSchema,
  Flux2Klein4bSettingsSchema,
  Flux2Klein9bSettingsSchema,
  Flux2MaxSettingsSchema,
  Flux2ProSettingsSchema,
  FluxKontextMaxSettingsSchema,
  FluxKontextProSettingsSchema,
  FluxFillSettingsSchema,
  Flux11ProSettingsSchema,
  Flux11UltraSettingsSchema,
  Seedream40SettingsSchema,
  Seedream45SettingsSchema,
  Seedream50LiteSettingsSchema,
  Seedream50ProSettingsSchema,
  MuseImageSettingsSchema,
  GrokImageSettingsSchema,
  GrokImage20SettingsSchema,
])
export type CatalogImageSettings = z.infer<typeof CatalogImageSettingsSchema>
export type CatalogImageControl = {
  key: 'size' | 'aspectRatio' | 'resolution' | 'outputFormat' | 'seed' | 'numberOfImages' | 'watermark' | 'imagePromptStrength'
  label: string
  type: 'select' | 'number' | 'checkbox'
  options?: readonly string[]
  min?: number
  max?: number
  step?: number
  optional?: boolean
}
type CatalogImageDefinition = {
  name: string
  provider: 'bfl' | 'bytedance' | 'meta' | 'spacexai'
  maxReferenceImages: number
  requiresMask: boolean
  referenceMode: 'images' | 'image-prompt'
  warnings: readonly string[]
  controls: readonly CatalogImageControl[]
}
const formatControl: CatalogImageControl = {key: 'outputFormat', label: 'Output format', type: 'select', options: ['png', 'jpeg']}
const seedControl: CatalogImageControl = {key: 'seed', label: 'Seed', type: 'number', min: 0, max: 2147483647, step: 1, optional: true}
export const CATALOG_IMAGE_DEFINITIONS: Record<CatalogImageModelId, CatalogImageDefinition> = {
  'bfl/flux-2-flex': {
    name: 'FLUX.2 Flex', provider: 'bfl', maxReferenceImages: 8,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'size', label: 'Output size', type: 'select', options: FLUX_SIZES, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-2-klein-4b': {
    name: 'FLUX.2 Klein 4B', provider: 'bfl', maxReferenceImages: 4,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'size', label: 'Output size', type: 'select', options: FLUX_SIZES, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-2-klein-9b': {
    name: 'FLUX.2 Klein 9B', provider: 'bfl', maxReferenceImages: 4,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'size', label: 'Output size', type: 'select', options: FLUX_SIZES, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-2-max': {
    name: 'FLUX.2 Max', provider: 'bfl', maxReferenceImages: 8,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'size', label: 'Output size', type: 'select', options: FLUX_SIZES, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-2-pro': {
    name: 'FLUX.2 Pro', provider: 'bfl', maxReferenceImages: 8,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'size', label: 'Output size', type: 'select', options: FLUX_SIZES, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-kontext-max': {
    name: 'FLUX Kontext Max', provider: 'bfl', maxReferenceImages: 1,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: FLUX_RATIOS, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-kontext-pro': {
    name: 'FLUX Kontext Pro', provider: 'bfl', maxReferenceImages: 1,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: FLUX_RATIOS, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-pro-1.0-fill': {
    name: 'FLUX Fill Pro', provider: 'bfl', maxReferenceImages: 1,
    requiresMask: true, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Requires a source and a same-size PNG mask. White areas are replaced; black areas are preserved."],
    controls: [formatControl, seedControl],
  },
  'bfl/flux-pro-1.1': {
    name: 'FLUX 1.1 Pro', provider: 'bfl', maxReferenceImages: 1,
    requiresMask: false, referenceMode: 'image-prompt',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Uses the picture as visual guidance; use FLUX Kontext or FLUX.2 for targeted edits."],
    controls: [{key: 'size', label: 'Output size', type: 'select', options: FLUX_11_SIZES, optional: true}, formatControl, seedControl],
  },
  'bfl/flux-pro-1.1-ultra': {
    name: 'FLUX 1.1 Pro Ultra', provider: 'bfl', maxReferenceImages: 1,
    requiresMask: false, referenceMode: 'image-prompt',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Uses the picture as visual guidance; use FLUX Kontext or FLUX.2 for targeted edits."],
    controls: [{key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: FLUX_RATIOS, optional: true}, formatControl, seedControl, {key: 'imagePromptStrength', label: 'Reference influence', type: 'number', min: 0, max: 1, step: 0.05}],
  },
  'bytedance/seedream-4.0': {
    name: 'Seedream 4.0', provider: 'bytedance', maxReferenceImages: 14,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'resolution', label: 'Resolution', type: 'select', options: ["1K","2K","4K"]}, {key: 'outputFormat', label: 'Output format', type: 'select', options: ["jpeg"]}, {key: 'watermark', label: 'AI-generated watermark', type: 'checkbox'}],
  },
  'bytedance/seedream-4.5': {
    name: 'Seedream 4.5', provider: 'bytedance', maxReferenceImages: 14,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'resolution', label: 'Resolution', type: 'select', options: ["2K","4K"]}, {key: 'outputFormat', label: 'Output format', type: 'select', options: ["jpeg"]}, {key: 'watermark', label: 'AI-generated watermark', type: 'checkbox'}],
  },
  'bytedance/seedream-5.0-lite': {
    name: 'Seedream 5.0 Lite', provider: 'bytedance', maxReferenceImages: 14,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'resolution', label: 'Resolution', type: 'select', options: ["2K","3K","4K"]}, {key: 'outputFormat', label: 'Output format', type: 'select', options: ["png","jpeg"]}, {key: 'watermark', label: 'AI-generated watermark', type: 'checkbox'}],
  },
  'bytedance/seedream-5.0-pro': {
    name: 'Seedream 5.0 Pro', provider: 'bytedance', maxReferenceImages: 10,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'resolution', label: 'Resolution', type: 'select', options: ["1K","2K"]}, {key: 'outputFormat', label: 'Output format', type: 'select', options: ["png","jpeg"]}, {key: 'watermark', label: 'AI-generated watermark', type: 'checkbox'}],
  },
  'meta/muse-image-1.0': {
    name: 'Muse Image 1.0', provider: 'meta', maxReferenceImages: 4,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Output dimensions are chosen by the model. One output per product."],
    controls: [],
  },
  'spacexai/grok-imagine-image': {
    name: 'Grok Imagine Image', provider: 'spacexai', maxReferenceImages: 3,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: GROK_RATIOS, optional: true}, {key: 'numberOfImages', label: 'Images per product', type: 'number', min: 1, max: 10, step: 1}],
  },
  'spacexai/grok-imagine-image-2.0': {
    name: 'Grok Imagine Image 2.0', provider: 'spacexai', maxReferenceImages: 5,
    requiresMask: false, referenceMode: 'images',
    warnings: ["Reference inputs are image files only; use PNG or JPEG.","Edits are described in the prompt. A separate mask is not supported."],
    controls: [{key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: GROK_RATIOS, optional: true}, {key: 'numberOfImages', label: 'Images per product', type: 'number', min: 1, max: 10, step: 1}, {key: 'resolution', label: 'Resolution', type: 'select', options: ['1k', '2k']}],
  },
}

export function isCatalogImageSettings(settings: {kind: string}): settings is CatalogImageSettings {
  return Object.hasOwn(CATALOG_IMAGE_DEFINITIONS, settings.kind)
}
export function createCatalogImageDefaults(model: CatalogImageModelId): CatalogImageSettings {
  return CatalogImageSettingsSchema.parse({kind: model})
}
