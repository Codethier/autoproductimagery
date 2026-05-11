import type {GenerateOptions} from "~~/schemas/main.dto";
import {useDB} from "~~/server/utils/useDB";
import {useGateway} from "~~/server/utils/useGateway";

const DEFAULT_MODEL = 'google/gemini-2.5-flash-image'
const MODEL_ALIASES: Record<string, string> = {
    'google/gemini-2.5-flash-image-preview': 'google/gemini-2.5-flash-image',
    'google/gemini-3-pro-image-preview': 'google/gemini-3-pro-image',
}

export default defineEventHandler(async (event) => {
    useAuth(event)
    const db = await useDB()
    const gw = await useGateway()
    const body = await readBody<GenerateOptions>(event)

    const requestedModel = body.model || DEFAULT_MODEL
    const model = MODEL_ALIASES[requestedModel] || requestedModel
    if (!model.includes('/')) {
        throw createError({
            statusCode: 400,
            statusMessage: `Model id must be in 'provider/model' form (got '${model}')`,
        })
    }

    const inputImages = Array.isArray(body.inputImages) ? body.inputImages : []
    const generationInputs: Array<string | null> = inputImages.length > 0 ? inputImages : [null]

    const results = await Promise.all(
        generationInputs.map(async (i) => {
            const jobInputImages = i ? [i] : []
            const job: GenerateOptions = {...body, inputImages: jobInputImages}
            try {
                const result = await gw.generateAnyImage({...job, model})
                return {ok: true, result, inputImage: i}
            } catch (e: any) {
                const refusedImages = e?.data?.refusedImages || jobInputImages
                const reason = e?.data?.reason || e?.statusMessage || e?.message || 'unknown'
                return {ok: false, inputImage: i, refusedImages, reason}
            }
        })
    )

    const outDir = './data/images/output'
    const fs = await import('node:fs/promises')
    await fs.mkdir(outDir, {recursive: true})

    function extFromMime(mime?: string) {
        switch (mime) {
            case 'image/png':
                return 'png'
            case 'image/jpeg':
                return 'jpg'
            case 'image/webp':
                return 'webp'
            case 'image/gif':
                return 'gif'
            case 'image/svg+xml':
                return 'svg'
            case 'image/bmp':
                return 'bmp'
            case 'image/tiff':
                return 'tiff'
            default:
                return 'bin'
        }
    }

    const objects = []
    for (const r of results as any[]) {
        let savedUrl: string = ''
        const result = r?.result
        if (r?.ok && result?.buffer && Buffer.isBuffer(result.buffer)) {
            const ext = extFromMime(result.mimeType)
            const fname = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
            const fullPath = `${outDir}/${fname}`
            await fs.writeFile(fullPath, result.buffer)
            savedUrl = `/images/output/${fname}`
        }
        const storedInputImages = body.storeInputImages === false
            ? []
            : r.inputImage ? [r.inputImage] : []
        const recordData: GenerateOptions = {...body, inputImages: storedInputImages}
        recordData.model = model
        let errMsg: string | undefined = undefined
        let billing = result?.billing || {model}
        if (!r?.ok) {
            recordData.prompt = 'Model refused these images' + (r?.reason ? ` (${r.reason})` : '')
            errMsg = r?.reason || 'unknown'
            billing = {model}
        }
        const q = await db.createSystemPrompt(recordData, savedUrl, errMsg, billing)
        objects.push(q)
    }
    return {ok: true, obj: objects}
});
