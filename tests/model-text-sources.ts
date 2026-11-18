import {IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, createDefaultSettings, type ImageGenerationSettings} from '../schemas/image-generation.ts'
import {CATALOG_IMAGE_DEFINITIONS} from '../schemas/catalog-image-models.ts'
import {getImageModelGuidance, imageControlHelp} from '../schemas/image-model-guidance.ts'
import {PIPELINE_TEXT_MODEL_PROFILES} from '../schemas/pipeline-text-models.ts'
import {BACKGROUND_REMOVAL_MODELS} from '../schemas/background-removal-models.ts'

const CONTROL_KEYS = ['size', 'aspectRatio', 'resolution', 'outputFormat', 'seed', 'numberOfImages', 'watermark', 'imagePromptStrength'] as const

// Settings variants that change curated guidance text: defaults, an active
// transparent background, and more than one output per job.
function settingsVariants(settings: ImageGenerationSettings): ImageGenerationSettings[] {
  const variants = [settings]
  if ('background' in settings) variants.push({...settings, background: 'transparent'} as ImageGenerationSettings)
  if ('numberOfImages' in settings) variants.push({...settings, numberOfImages: 3} as ImageGenerationSettings)
  return variants
}

/**
 * Every curated, UI-visible English string that the UI passes through
 * `modelText(...)`, keyed by where it comes from. Model names, IDs and option
 * values are excluded: they stay untranslated.
 */
export function curatedModelTexts(): Map<string, string> {
  const texts = new Map<string, string>()
  const add = (source: string, text: string | undefined) => { if (text && !texts.has(text)) texts.set(text, source) }
  for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[id]
    add(`${id} description`, profile.description)
    add(`${id} lifecycleNote`, profile.lifecycleNote)
    for (const warning of profile.warnings) add(`${id} warning`, warning)
    for (const settings of settingsVariants(createDefaultSettings(id))) {
      const guidance = getImageModelGuidance(id, settings)!
      for (const field of ['purpose', 'references', 'transparency', 'output', 'settings', 'promptExample'] as const) add(`${id} guidance.${field}`, guidance[field])
      if (guidance.mask) for (const field of ['title', 'meaning', 'preparation', 'example'] as const) add(`${id} guidance.mask.${field}`, guidance.mask[field])
    }
    for (const key of CONTROL_KEYS) add(`${id} help.${key}`, imageControlHelp(id, key))
  }
  for (const [id, definition] of Object.entries(CATALOG_IMAGE_DEFINITIONS)) {
    for (const control of definition.controls) add(`${id} control.${control.key}`, control.label)
    for (const warning of definition.warnings) add(`${id} warning`, warning)
  }
  for (const profile of Object.values(PIPELINE_TEXT_MODEL_PROFILES)) {
    add(`${profile.id} description`, profile.description)
    add(`${profile.id} reasoningHelp`, profile.reasoningHelp)
  }
  for (const model of BACKGROUND_REMOVAL_MODELS) {
    add(`${model.id} label`, model.label)
    add(`${model.id} description`, model.description)
  }
  return texts
}
