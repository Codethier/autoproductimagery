import { watch } from 'vue'
import { IMAGE_MODEL_PROFILES, createDefaultSettings, type ImageGenerationSettings, type ImageModelId } from '../../schemas/image-generation'

export function watchImageModelSelection(state: {
  selectedModel: ImageModelId
  generationSettings: ImageGenerationSettings
  maskImage: string | null
}) {
  return watch(() => state.selectedModel, (model, previousModel) => {
    if (model !== previousModel) state.generationSettings = createDefaultSettings(model)
    const profile = IMAGE_MODEL_PROFILES[model]
    if (!profile.supportsMask || profile.maskMode !== IMAGE_MODEL_PROFILES[previousModel].maskMode) {
      state.maskImage = null
    }
  }, {flush: 'sync'})
}
