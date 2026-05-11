import { db } from "~~/server/utils/lib/db";
import { systemPrompt } from "~~/server/db/schema";
import { desc, eq, sql as drizzleSql } from "drizzle-orm";
import type { GenerateOptions } from "~~/schemas/main.dto";

export type GenerationBilling = {
    model?: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    priceUsd?: string
    gatewayGenerationId?: string
    usageJson?: Record<string, unknown>
}

export async function useDB() {
    async function ensureSystemPromptBillingColumns() {
        const rows = await db.all(drizzleSql.raw("PRAGMA table_info(systemPrompt)"))
        if (rows.length === 0) return
        const existing = new Set(rows.map((row: any) => row.name))
        const additions: Array<[string, string]> = [
            ['generationModel', 'ALTER TABLE `systemPrompt` ADD `generationModel` text'],
            ['inputTokens', 'ALTER TABLE `systemPrompt` ADD `inputTokens` integer'],
            ['outputTokens', 'ALTER TABLE `systemPrompt` ADD `outputTokens` integer'],
            ['totalTokens', 'ALTER TABLE `systemPrompt` ADD `totalTokens` integer'],
            ['cachedInputTokens', 'ALTER TABLE `systemPrompt` ADD `cachedInputTokens` integer'],
            ['reasoningTokens', 'ALTER TABLE `systemPrompt` ADD `reasoningTokens` integer'],
            ['priceUsd', 'ALTER TABLE `systemPrompt` ADD `priceUsd` text'],
            ['gatewayGenerationId', 'ALTER TABLE `systemPrompt` ADD `gatewayGenerationId` text'],
            ['usageJson', 'ALTER TABLE `systemPrompt` ADD `usageJson` text'],
        ]
        for (const [name, sql] of additions) {
            if (!existing.has(name)) await db.run(drizzleSql.raw(sql))
        }
    }

    await ensureSystemPromptBillingColumns()

    async function createSystemPrompt(data: GenerateOptions, outputImage: string, errors?: string, billing: GenerationBilling = {}){
        const modelImages = Array.isArray(data.modelImages) ? data.modelImages : []
        const serverImages = Array.isArray(data.inputImages) ? data.inputImages : []

        const result = await db.insert(systemPrompt).values({
            TextPrompt: data.prompt,
            serverImages: serverImages as any,
            modelImages: modelImages as any,
            outputImage: outputImage,
            generationModel: billing.model ?? data.model ?? null as any,
            inputTokens: billing.inputTokens ?? null as any,
            outputTokens: billing.outputTokens ?? null as any,
            totalTokens: billing.totalTokens ?? null as any,
            cachedInputTokens: billing.cachedInputTokens ?? null as any,
            reasoningTokens: billing.reasoningTokens ?? null as any,
            priceUsd: billing.priceUsd ?? null as any,
            gatewayGenerationId: billing.gatewayGenerationId ?? null as any,
            usageJson: billing.usageJson ?? null as any,
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
