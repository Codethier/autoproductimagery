import {Dirent} from "node:fs";
import {number, string} from "yup";

export type GenerateOptions = {
    prompt: string
    model?: string
    responseModalities?: Array<'IMAGE' | 'TEXT'>
    inputImages: Array<string>
    modelImages?: Array<string>
    storeInputImages?: boolean
    safetySettings: any
    imageConfig?: imageConfig

    maxOutputTokens?: number
}

type imageConfig= {
    aspectRatio?: string
    // default is 1K in API
    imageSize?: '1K' | '2K' | '4K'
}
export type inputImages = { mimeType: string; dataBase64: string }

export type StreamChunk = {
    type: 'image' | 'text'
    data: Buffer | string
    mimeType?: string
}

export type SelectableFile = {
    name: string
    parentPath: string
    url: string
    selectedModel: boolean
    selectedImage: boolean
}

export type  typeFileUploadDTO = {
    files: Array<File>
}
