import {
  generationOutputCount, getImageModelProfile,
  type ImageGenerationSettings, type ImageModelId,
} from './image-generation'

type ModelAdvice = {purpose: string; prompt?: string; settings?: string}

// Advice is curated by exact profile ID. It describes this application's
// implemented controls; provider capabilities outside that route stay separate.
const advice: Readonly<Record<ImageModelId, ModelAdvice>> = {
  'openai/gpt-image-2.5-sunburst': {purpose: 'Use for detailed product edits. Describe the change and explicitly name the product details that must stay the same.', settings: 'Start with Auto quality. Increase it when a specific detail needs improvement; a higher setting can take longer and does not guarantee a better result.'},
  'openai/gpt-image-2.5-flare': {purpose: 'Use for everyday image edits and new compositions when speed matters. Describe the subject, setting, lighting, and details to preserve.'},
  'openai/gpt-image-2': {purpose: 'Use for product edits with custom output dimensions. Its mask guides local edits; this app currently exposes only Auto and Opaque backgrounds.'},
  'openai/gpt-image-1.5': {purpose: 'Create or edit product images with a fixed output size, optional edit mask, and optional transparent background.'},
  'openai/gpt-image-1': {purpose: 'A legacy image editor with fixed sizes, optional edit masks, and transparent output. Keep it for comparing or repeating earlier work.'},
  'openai/gpt-image-1-mini': {purpose: 'A smaller legacy image editor with fixed sizes, optional edit masks, and transparent output. Inspect fine product details before using a result.'},
  'google/gemini-3.1-flash-image': {purpose: 'Combine product, person, and style references in one image. Explain which picture supplies each detail and what should remain unchanged.', settings: 'Thinking controls planning before the image. Grounding adds search information; it does not select your uploaded references.'},
  'google/gemini-3-pro-image': {purpose: 'Describe complex compositions and text precisely. Assign a clear role to each product, person, or style reference.', settings: 'Thinking is always enabled. Include thoughts stores a returned summary; it does not turn thinking on or off.'},
  'google/gemini-3.1-flash-lite-image': {purpose: 'Use for straightforward edits at the fixed 1K size. Start with a small set of clear references for simpler compositions.', settings: 'Thinking is configurable, but search grounding and other output-size tiers are unavailable for this model.'},
  'google/gemini-2.5-flash-image': {purpose: 'A legacy 1024-class image editor retained for older work. Describe edits in text; thinking and search controls are unavailable.'},
  'bfl/flux-2-flex': {purpose: 'Combine several references for a product edit. Name the subject, lighting, and role of each reference.'},
  'bfl/flux-2-klein-4b': {purpose: 'Edit or compose from a small set of references. Name the change and the product features to preserve.'},
  'bfl/flux-2-klein-9b': {purpose: 'Edit or compose from a small set of references. Name the change and the product features to preserve.'},
  'bfl/flux-2-max': {purpose: 'Combine several references for a product edit. Specify which details come from each picture.'},
  'bfl/flux-2-pro': {purpose: 'Combine several references for a product edit. Specify which details come from each picture.'},
  'bfl/flux-kontext-max': {purpose: 'Make a targeted edit to one source picture. Describe exactly what to change and what to keep.'},
  'bfl/flux-kontext-pro': {purpose: 'Make a targeted edit to one source picture. Describe exactly what to change and what to keep.'},
  'bfl/flux-pro-1.0-fill': {purpose: 'Replace part of one picture using a required black-and-white fill mask and a prompt for the replacement.', prompt: 'Replace the white masked background with a warm studio wall. Keep the product in the black area.'},
  'bfl/flux-pro-1.1': {purpose: 'Use one picture as visual inspiration for a new composition. For a targeted edit of the original, choose FLUX Kontext or FLUX.2.'},
  'bfl/flux-pro-1.1-ultra': {purpose: 'Use one picture as visual inspiration for a new composition. Reference influence controls how strongly it guides the result.'},
  'bytedance/seedream-4.0': {purpose: 'Create an image from several product or person references. Describe each picture’s role and choose the output resolution.'},
  'bytedance/seedream-4.5': {purpose: 'Create an image from several product or person references. Describe each picture’s role and choose the output resolution.'},
  'bytedance/seedream-5.0-lite': {purpose: 'Combine product or person references. Choose the resolution and output format separately from your prompt.'},
  'bytedance/seedream-5.0-pro': {purpose: 'Combine product or person references. Choose the resolution and output format separately from your prompt.'},
  'meta/muse-image-1.0': {purpose: 'Describe a composition using the uploaded pictures. This model chooses its output dimensions and format; there are no size controls.'},
  'spacexai/grok-imagine-image': {purpose: 'Edit or compose from a few references. Choose the framing with Aspect ratio and use Images per product for variations.'},
  'spacexai/grok-imagine-image-2.0': {purpose: 'Edit or compose from a few references. Choose Aspect ratio, Resolution, and Images per product separately from your prompt.'},
}

export type ImageModelGuidance = {
  modelName: string
  purpose: string
  references: string
  mask?: {title: string; meaning: string; preparation: string; example: string}
  transparency: string
  output: string
  settings?: string
  promptExample: string
}

export function imageControlHelp(modelId: string, key: string): string | undefined {
  if (!getImageModelProfile(modelId)) return undefined
  switch (key) {
    case 'size': return 'The generated picture’s width and height. This does not resize your source or mask.'
    case 'aspectRatio': return 'The shape of the output: 1:1 is square, 16:9 is wide, and 9:16 is tall. This is separate from resolution.'
    case 'resolution': return 'The output resolution tier. Larger pictures can take longer; the result’s actual dimensions appear in its details.'
    case 'outputFormat': return 'The file type saved for the result. PNG output alone does not create a transparent background.'
    case 'seed': return 'An optional starting value for random generation. Keep other settings and inputs the same for comparisons; a seed does not guarantee identical images.'
    case 'numberOfImages': return 'Variations returned for each input job. Inputs × variations cannot exceed 50 output images per request.'
    case 'watermark': return 'Adds the model’s visible AI-generated watermark to the output when enabled.'
    case 'imagePromptStrength': return modelId === 'bfl/flux-pro-1.1-ultra' ? 'How strongly the uploaded picture guides the new composition, from 0 to 1. It does not select an area to edit.' : undefined
    default: return undefined
  }
}

export function getImageModelGuidance(modelId: string, settings?: ImageGenerationSettings): ImageModelGuidance | undefined {
  const profile = getImageModelProfile(modelId)
  if (!profile) return undefined
  const item = advice[profile.id]
  const currentSettings = settings?.kind === profile.settingsKind ? settings : undefined
  const count = currentSettings ? generationOutputCount(currentSettings) : 1
  const mask = !profile.supportsMask ? undefined : profile.maskMode === 'luminance'
    ? {
      title: 'Fill mask · white replaces, black keeps',
      meaning: 'The mask marks the part of the source to replace. White selects the replacement area; black keeps the original area. This model requires a mask.',
      preparation: 'Upload a black-and-white PNG with the same width and height as the source. Use the same dimensions for every input in a batch.',
      example: 'For a new background, paint the background white and the product black in a separate image editor, then upload that PNG as the mask.',
    }
    : {
      title: 'Edit mask · transparent areas change',
      meaning: 'The mask guides where to make an edit on the first source image. Fully transparent areas mark what to change; opaque areas mark what to keep. The model can still change details outside the mask.',
      preparation: 'Use a PNG with an alpha channel, prepared in a separate image editor. In this app, the source must also be PNG and match the mask’s width and height. Every input in a batch must match.',
      example: 'To change a background, make the background transparent in the mask and keep the product opaque. Describe the replacement background in your prompt.',
    }
  const transparency = profile.supportsTransparentBackground
    ? currentSettings && 'background' in currentSettings && currentSettings.background === 'transparent'
      ? 'Transparent output is selected. PNG or WebP preserves the alpha channel; JPEG cannot. An input edit mask and an output transparent background are separate choices.'
      : 'For a transparent image, choose Background → Transparent and use PNG or WebP. A white backdrop or a drawn checkerboard does not create transparency.'
    : 'Transparent output is not available through this model in this app. PNG alone does not make a cutout. Use Remove backgrounds for a transparent product image.'
  return {
    modelName: profile.name,
    purpose: item.purpose,
    references: profile.referenceMode === 'image-prompt'
      ? 'The picture supplies visual guidance, rather than an exact area to edit. This model accepts one picture per job.'
      : `The source is the picture being edited. Extra references guide identity, clothing, style, or composition. This model accepts up to ${profile.maxReferenceImages} pictures in one job, counting the source and references together.`,
    mask, transparency,
    output: `${count} output image${count === 1 ? '' : 's'} per job with these settings. Each batch input runs independently; shared references repeat for every input. A request can produce at most 50 images. Final prices appear after they are confirmed.`,
    settings: item.settings,
    promptExample: item.prompt ?? 'Keep the product’s shape, colour, fabric, and labels. Change only the background to a warm studio setting with soft light.',
  }
}
