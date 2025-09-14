import {Dirent} from "node:fs";

export type GenerateOptions = {
    prompt: string
    model?: string
    responseModalities?: Array<'IMAGE' | 'TEXT'>
    inputImages?: Array<inputImages>
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