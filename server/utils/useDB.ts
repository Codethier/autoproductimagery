import { db } from "~~/server/utils/lib/db";
import { systemPrompt } from "~~/server/db/schema";
import { desc, eq } from "drizzle-orm";
import type { GenerateOptions } from "~~/schemas/main.dto";

export async function useDB() {
    async function createSystemPrompt(data: GenerateOptions, outputImage: string, errors?: string){
        const modelImages = Array.isArray(data.modelImages) ? data.modelImages : []
        const serverImages = Array.isArray(data.inputImages) ? data.inputImages : []

        const result = await db.insert(systemPrompt).values({
            TextPrompt: data.prompt,
            serverImages: serverImages as any,
            modelImages: modelImages as any,
            outputImage: outputImage,
            errors: errors ?? null as any,
            // createdAt and updatedAt will default in DB
        }).run();

        const id = Number((result as any)?.lastInsertRowid ?? 0);
        if (id) {
            const [row] = await db.select().from(systemPrompt).where(eq(systemPrompt.id, id));
            return row;
        }
        // fallback: return last row
        const [row] = await db.select().from(systemPrompt).orderBy(desc(systemPrompt.id)).limit(1);
        return row;
    }

    async function getSystemPrompts() {
        const rows = await db.select().from(systemPrompt)
            .orderBy(desc(systemPrompt.createdAt))
        return rows
    }

    return {createSystemPrompt, getSystemPrompts}
}