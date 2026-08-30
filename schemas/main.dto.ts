import type { ImageGenerationRequest } from './image-generation'

// Kept as an alias while older imports are migrated. The runtime contract lives
// in image-generation.ts and must be parsed at every API boundary.
export type GenerateOptions = ImageGenerationRequest
export type inputImages = { mimeType: string; dataBase64: string }

export type StreamChunk = {
    type: 'image' | 'text'
    data: Buffer | string
    mimeType?: string
}

export type SelectableFile = {
    name: string
    url: string
    selectedModel: boolean
    selectedImage: boolean
    selectedMask: boolean
}

export type  typeFileUploadDTO = {
    files: Array<File>
}
