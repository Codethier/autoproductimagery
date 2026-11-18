import {
  IMAGE_MODEL_PROFILES,
  ImageGenerationRequestSchema,
  DEFAULT_IMAGE_SAVE_FORMAT,
  type ImageGenerationSettings,
  type ImageSaveFormat,
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

/**
 * Client-side composer validation failure. `messageKey` names the localized
 * text in the `generation` namespace; `message` keeps the English original for
 * logs and non-UI callers. This module stays free of Vue/i18n runtime imports.
 */
export class ComposerValidationError extends Error {
  readonly messageKey: string
  constructor(messageKey: string, englishMessage: string) {
    super(englishMessage)
    this.name = 'ComposerValidationError'
    this.messageKey = messageKey
  }
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
  saveFormat?: ImageSaveFormat
}) {
  const inputImages = composerSources(options.mode, options.editSource, options.batchInputs)
  if (!inputImages.length) {
    throw options.mode === 'edit'
      ? new ComposerValidationError('generation.validation.chooseEditImage', 'Choose an image to edit.')
      : new ComposerValidationError('generation.validation.chooseBatchInput', 'Choose at least one input image for the batch.')
  }

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
    saveFormat: options.saveFormat ?? DEFAULT_IMAGE_SAVE_FORMAT,
  })
  // Sources may be any stored format: the server converts them to PNG for
  // masked GPT Image edits. The mask itself must still be a PNG.
  if (request.maskImage && !/\.png(?:$|[?#])/i.test(request.maskImage)) {
    throw new ComposerValidationError('generation.validation.maskNotPngImage', 'The mask must be a PNG image.')
  }
  return request
}

export function imageName(path: string): string {
  const name = path.split('/').pop() || 'Image'
  try { return decodeURIComponent(name) } catch { return name }
}
