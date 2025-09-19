import type {GenerateOptions} from "~~/schemas/main.dto";
import {useDB} from "~~/server/utils/useDB";
import type { systemPrompt } from "@prisma/client";

export default defineEventHandler(async (event) => {
    useAuth(event)
    let db = await useDB()
    const gemini = await useGemini()
    const body = await readBody<GenerateOptions>(event)

    let streams = []
    for (let i of body.inputImages) {
        let geminiJob: GenerateOptions = {...body}
        geminiJob.inputImages = [i]
        streams.push(await gemini.generateStream(geminiJob))
    }

    // Ensure output directory exists under public so the file is web-accessible
    const outDir = './public/output'
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


    let objects: systemPrompt[] = []
    for (let stream of streams) {
        let savedUrl: string = ''
        for await (const chunk of stream) {
            if (chunk.type === 'image' && Buffer.isBuffer(chunk.data)) {
                const ext = extFromMime(chunk.mimeType)
                const fname = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
                const fullPath = `${outDir}/${fname}`
                await fs.writeFile(fullPath, chunk.data)
                // Public URL relative to site root
                savedUrl = `/output/${fname}`
                break
            }
        }
        let q = await db.createSystemPrompt(body, savedUrl)
        objects.push(q)
    }
    return {ok: true,obj: objects}
});