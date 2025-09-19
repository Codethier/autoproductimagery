import prisma from "~~/server/utils/lib/prisma";
import type {GenerateOptions} from "~~/schemas/main.dto";

export async function useDB() {
    async function createSystemPrompt(data: GenerateOptions, outputImage: string){
        const modelImages = Array.isArray(data.modelImages) ? data.modelImages : []
        const serverImages = Array.isArray(data.inputImages) ? data.inputImages : []

        const created = await prisma.systemPrompt.create({
            data: {
                TextPrompt: data.prompt,
                serverImages: serverImages as any,
                modelImages: modelImages as any,
                outputImage: outputImage,
            }
        })

        return created
    }

    async function getSystemPrompts(opts?: { take?: number; skip?: number }) {
        const { take = 50, skip = 0 } = opts || {}
        const rows = await prisma.systemPrompt.findMany({
            orderBy: { createdAt: 'desc' },
            take,
            skip,
        })
        return rows
    }

    return {createSystemPrompt, getSystemPrompts}
}