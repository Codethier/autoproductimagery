import {
  IMAGE_MODEL_PROFILES,
  ImageGenerationRequestSchema,
  type ImageGenerationSettings,
  type ImageModelId,
} from '../../schemas/image-generation'

export type GenerationComposerMode = 'edit' | 'batch'

export type PendingGeneration = {
  id: string
  prompt: string
  model: string
  inputImages: string[]
  modelImages: string[]
  startedAt: number
  status: 'pending' | 'failed'
  error?: string
}

export function composerSources(mode: GenerationComposerMode, editSource: string | null, batchInputs: readonly string[]): string[] {
  return mode === 'edit' ? (editSource ? [editSource] : []) : [...batchInputs]
}

export function buildComposerRequest(options: {
  mode: GenerationComposerMode
  editSource: string | null
  batchInputs: readonly string[]
  prompt: string
  model: ImageModelId
  settings: ImageGenerationSettings
  sharedReferences: readonly string[]
  maskImage: string | null
}) {
  const inputImages = composerSources(options.mode, options.editSource, options.batchInputs)
  if (!inputImages.length) throw new Error(options.mode === 'edit' ? 'Choose an image to edit.' : 'Choose at least one input image for the batch.')

  // One endpoint owns the bounded batch execution. Each input becomes one
  // independent job with the same prompt, settings, and shared references.
  const request = ImageGenerationRequestSchema.parse({
    prompt: options.prompt,
    model: options.model,
    settings: structuredClone(options.settings),
    inputImages,
    modelImages: [...options.sharedReferences],
    ...(options.maskImage ? { maskImage: options.maskImage } : {}),
    storeInputImages: true,
  })
  if (request.maskImage) {
    if (!/\.png(?:$|[?#])/i.test(request.maskImage)) throw new Error('The mask must be a PNG image.')
    if (IMAGE_MODEL_PROFILES[request.model].maskMode !== 'luminance'
      && request.inputImages.some(source => !/\.png(?:$|[?#])/i.test(source))) {
      throw new Error('Every source must be PNG when using this edit mask.')
    }
  }
  return request
}

export function imageName(path: string): string {
  const name = path.split('/').pop() || 'Image'
  try { return decodeURIComponent(name) } catch { return name }
}
