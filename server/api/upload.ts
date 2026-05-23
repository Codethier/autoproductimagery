import { createError } from "h3"

const MAX_FILE_BYTES = 25 * 1024 * 1024

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "POST")

    const fs = await useFS()
    const formData = await readMultipartFormData(event)
    if (!formData?.length) {
        throw createError({ statusCode: 400, statusMessage: "Empty upload" })
    }

    const pathPart = formData.find((p) => p.name === "path")
    const filesForm = formData.filter((p) => p.name === "files" && p.filename)

    if (!pathPart) {
        throw createError({ statusCode: 400, statusMessage: "Missing path" })
    }
    if (filesForm.length === 0) {
        throw createError({ statusCode: 400, statusMessage: "No files attached" })
    }

    const targetPath = pathPart.data.toString("utf-8")
    const saved: string[] = []
    const failed: Array<{ filename: string; reason: string }> = []

    for (const file of filesForm) {
        try {
            if (file.data.byteLength > MAX_FILE_BYTES) {
                throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes`)
            }
            const name = await fs.saveFile(targetPath, file)
            saved.push(name)
        } catch (err: any) {
            failed.push({ filename: file.filename ?? "(unnamed)", reason: err?.message ?? "unknown" })
        }
    }

    return { saved, failed }
})
