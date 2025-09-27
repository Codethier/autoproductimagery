import {Dirent} from "node:fs";
import {number} from "yup";

export type GenerateOptions = {
    prompt: string
    model?: string
    responseModalities?: Array<'IMAGE' | 'TEXT'>
    inputImages: Array<string>
    modelImages?: Array<string>
    safetySettings: any

    topP?: number
    // Probability threshold for top-p sampling , 0.00 --> 1.00
    temperature?: number
    // Creativity allowed in the responses 0.00 --> 1.00
    maxOutputTokens?: number
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