// composables/useBase64FromFile.ts
export function useBase64FromFile() {
    async function fileToBase64Raw(
        file: File
    ): Promise<{ mimeType: string; dataBase64: string }> {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(new Error('Failed to read file'))
            reader.onload = () => resolve(String(reader.result || ''))
            reader.readAsDataURL(file)
        })

        const comma = dataUrl.indexOf(',')
        const dataBase64 = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl

        const match = /^data:([^;]+);base64,/i.exec(dataUrl)
        const mimeType = match?.[1] || file.type || 'application/octet-stream'

        return {mimeType, dataBase64}
    }

    return {fileToBase64Raw}
}