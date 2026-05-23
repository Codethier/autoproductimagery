import { db } from "~~/server/utils/lib/db";
import { aiGatewayLog, systemPrompt, type NewAiGatewayLog } from "~~/server/db/schema";
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
    priceSource?: 'gateway' | 'estimate' | 'unknown'
    gatewayGenerationId?: string
    usageJson?: Record<string, unknown>
}

export async function useDB() {
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
            priceSource: billing.priceSource ?? null as any,
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

    async function getSystemPrompt(id: number) {
        const [row] = await db.select().from(systemPrompt).where(eq(systemPrompt.id, id)).limit(1)
        return row
    }

    async function updateSystemPromptBilling(id: number, billing: GenerationBilling) {
        const values: Record<string, unknown> = {
                inputTokens: billing.inputTokens ?? null as any,
                outputTokens: billing.outputTokens ?? null as any,
                totalTokens: billing.totalTokens ?? null as any,
                cachedInputTokens: billing.cachedInputTokens ?? null as any,
                reasoningTokens: billing.reasoningTokens ?? null as any,
                priceUsd: billing.priceUsd ?? null as any,
                priceSource: billing.priceSource ?? null as any,
                usageJson: billing.usageJson ?? null as any,
                updatedAt: drizzleSql`CURRENT_TIMESTAMP`,
        }
        if (billing.model) values.generationModel = billing.model
        if (billing.gatewayGenerationId) values.gatewayGenerationId = billing.gatewayGenerationId

        await db.update(systemPrompt)
            .set(values as any)
            .where(eq(systemPrompt.id, id))
            .run()
        return getSystemPrompt(id)
    }

    async function getSystemPrompts() {
        const rows = await db.select().from(systemPrompt)
            .orderBy(desc(systemPrompt.createdAt))
        return rows
    }

    async function createAiGatewayLog(data: NewAiGatewayLog) {
        const result = await db.insert(aiGatewayLog).values(data).run()
        const id = Number((result as any)?.lastInsertRowid ?? 0)
        if (id) {
            const [row] = await db.select().from(aiGatewayLog).where(eq(aiGatewayLog.id, id))
            return row
        }
        const [row] = await db.select().from(aiGatewayLog).orderBy(desc(aiGatewayLog.id)).limit(1)
        return row
    }

    async function getAiGatewayLogs(limit = 50) {
        return db.select().from(aiGatewayLog)
            .orderBy(desc(aiGatewayLog.createdAt), desc(aiGatewayLog.id))
            .limit(Math.max(1, Math.min(200, limit)))
    }

    return {
        createSystemPrompt,
        getSystemPrompt,
        updateSystemPromptBilling,
        getSystemPrompts,
        createAiGatewayLog,
        getAiGatewayLogs,
    }
}
