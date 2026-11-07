import { randomUUID } from "node:crypto"
import path from "node:path"
import { parseStreamingUpload, withUploadSlot } from "../utils/uploadPolicy"

function clientFilename(value: string | undefined) {
    const base = path.basename(value || "(unnamed)")
    return base.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "(unnamed)"
}

export default defineEventHandler(async (event) => {
    const actor = await useAuth(event)
    assertMethod(event, "POST")

    return withUploadSlot(async () => {
        const { path: targetPath, files } = await parseStreamingUpload(event)
        const fs = await useUserFS(actor)
        const saved: string[] = []
        const savedFiles: import('~~/schemas/image-storage').AssetFile[] = []
        const failed: Array<{ filename: string; reason: string }> = []

        for (const file of files) {
            const filename = clientFilename(file.filename)
            try {
                const image = await fs.saveUpload(targetPath, file)
                saved.push(image.name)
                savedFiles.push(image)
            } catch (err: any) {
                const statusCode = Number(err?.statusCode)
                if (statusCode >= 400 && statusCode < 500) {
                    failed.push({ filename, reason: err?.statusMessage || "Invalid image" })
                    continue
                }
                const diagnosticId = randomUUID()
                console.error("[image-upload] Could not store image", { diagnosticId, filename, error: err })
                failed.push({ filename, reason: `Could not store image (reference ${diagnosticId})` })
            } finally {
                file.data = Buffer.alloc(0)
            }
        }

        return { saved, savedFiles, failed }
    })
})
