import {
    ImageGenerationRequestSchema,
    isOpenAiImageSettings,
    isGeminiImageSettings,
    ImageModelIdSchema,
    canonicalizeImageModelId,
    createDefaultSettings,
    type ImageGenerationRequest,
    type ImageGenerationSettings,
} from '~~/schemas/image-generation'
import {installBoundedRawBody} from '~~/server/utils/boundedRequestBody'
import {runAccountImageGeneration} from '~~/server/utils/imageGenerationService'

type RawBody = Record<string, unknown>
const MAX_GENERATION_REQUEST_BYTES = 512 * 1024

function translateLegacySettings(
    model: ImageGenerationRequest['model'],
    raw: RawBody,
): ImageGenerationSettings {
    if (raw.settings) return raw.settings as ImageGenerationSettings
    const defaults = createDefaultSettings(model)
    const legacy = raw.imageConfig && typeof raw.imageConfig === 'object'
        ? raw.imageConfig as Record<string, unknown>
        : {}
    if (isOpenAiImageSettings(defaults)) {
        return {
            ...defaults,
            ...(typeof legacy.size === 'string' ? {size: legacy.size} : {}),
        } as ImageGenerationSettings
    }
    if (!isGeminiImageSettings(defaults)) return defaults
    return {
        ...defaults,
        ...(typeof legacy.aspectRatio === 'string' ? {aspectRatio: legacy.aspectRatio} : {}),
        ...('imageSize' in defaults && typeof legacy.imageSize === 'string'
            ? {imageSize: legacy.imageSize}
            : {}),
    } as ImageGenerationSettings
}

function parseRequest(raw: RawBody) {
    const requestedModel = typeof raw.model === 'string' ? raw.model : undefined
    const canonicalModel = canonicalizeImageModelId(requestedModel)
    const parsedModel = ImageModelIdSchema.safeParse(canonicalModel)
    if (!parsedModel.success) {
        throw createError({
            statusCode: 400,
            statusMessage: `Unsupported image model '${canonicalModel}'. Choose one of the supported image models.`,
        })
    }
    const candidate = {
        prompt: raw.prompt,
        model: parsedModel.data,
        inputImages: raw.inputImages ?? [],
        modelImages: raw.modelImages ?? [],
        maskImage: raw.maskImage,
        storeInputImages: raw.storeInputImages ?? true,
        parentSystemPromptId: raw.parentSystemPromptId,
        personId: raw.personId,
        personPictureCount: raw.personPictureCount,
        settings: translateLegacySettings(parsedModel.data, raw),
    }
    const parsed = ImageGenerationRequestSchema.safeParse(candidate)
    if (!parsed.success) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Invalid image generation request',
            data: {issues: parsed.error.issues},
        })
    }
    return {
        request: parsed.data,
        requestedModel: requestedModel ?? parsed.data.model,
    }
}

export default defineEventHandler(async (event) => {
    const account = await useAuth(event)
    await installBoundedRawBody(event, MAX_GENERATION_REQUEST_BYTES)
    const raw = await readBody<RawBody>(event)
    const {request, requestedModel} = parseRequest(raw ?? {})
    return runAccountImageGeneration(account, request, {requestedModel})
})
