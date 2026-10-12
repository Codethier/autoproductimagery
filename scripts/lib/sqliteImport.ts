import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { getTableColumns, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { aiGatewayLog, systemPrompt, type NewAiGatewayLog, type NewSystemPrompt } from '../../server/db/schema.ts'

type LegacyRow = Record<string, SQLOutputValue>
export type LegacyImportSummary = {generations: number; gatewayLogs: number}

export class LegacyImportError extends Error {}

const generationJsonFields = new Set(['serverImages', 'modelImages', 'usageJson', 'generationConfig', 'outputMetadata', 'errorJson'])
const gatewayJsonFields = new Set(['inputImages', 'modelImages', 'requestJson', 'responseJson', 'resolvedConfigJson', 'errorJson'])
const arrayFields = new Set(['serverImages', 'modelImages', 'inputImages'])

function legacyTimestamp(value: SQLOutputValue, column: string): string {
    if (typeof value !== 'string') throw new LegacyImportError(`Legacy ${column} timestamp is invalid.`)
    // SQLite CURRENT_TIMESTAMP has no offset and represents UTC.
    const input = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
        ? value.replace(' ', 'T') + 'Z'
        : value
    const timestamp = new Date(input)
    if (!Number.isFinite(timestamp.getTime())) throw new LegacyImportError(`Legacy ${column} timestamp is invalid.`)
    return timestamp.toISOString()
}

function normalizedLegacyRow(row: LegacyRow, table: typeof systemPrompt | typeof aiGatewayLog, jsonFields: Set<string>): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    const columns = getTableColumns(table)
    for (const [name, column] of Object.entries(columns)) {
        const value = row[name]
        if (value === undefined) continue
        if (value === null) {
            if (column.notNull) throw new LegacyImportError(`Legacy required column ${name} is missing.`)
            values[name] = null
        } else if (jsonFields.has(name)) {
            if (typeof value !== 'string') throw new LegacyImportError(`Legacy ${name} JSON is invalid.`)
            let decoded: unknown
            try { decoded = JSON.parse(value) } catch { throw new LegacyImportError(`Legacy ${name} JSON is invalid.`) }
            if (arrayFields.has(name)) {
                if (!Array.isArray(decoded) || !decoded.every(item => typeof item === 'string')) {
                    throw new LegacyImportError(`Legacy ${name} must contain an image-path array.`)
                }
            } else if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
                throw new LegacyImportError(`Legacy ${name} must contain a JSON object.`)
            }
            // Preserve historical settings and diagnostics byte-for-byte as
            // JSON values. Runtime replay still validates the current schemas.
            values[name] = decoded
        } else if (name === 'createdAt' || name === 'updatedAt') {
            values[name] = legacyTimestamp(value, name)
        } else if (column.dataType.startsWith('number')) {
            const numeric = typeof value === 'bigint' ? Number(value) : value
            if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) {
                throw new LegacyImportError(`Legacy ${name} must be a safe integer.`)
            }
            values[name] = numeric
        } else {
            if (typeof value !== 'string') throw new LegacyImportError(`Legacy ${name} text is invalid.`)
            values[name] = value
        }
    }
    if (typeof values.id !== 'number' || values.id <= 0) throw new LegacyImportError('Legacy row id is invalid.')
    if (table === systemPrompt && values.status != null && !['pending', 'succeeded', 'failed'].includes(String(values.status))) {
        throw new LegacyImportError('Legacy generation status is invalid.')
    }
    return values
}

function* legacyRows(sqlite: DatabaseSync, table: 'systemPrompt' | 'aiGatewayLog') {
    const exists = sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)
    if (!exists) {
        if (table === 'systemPrompt') throw new LegacyImportError('Source SQLite has no generation table.')
        return
    }
    let afterId = 0
    while (true) {
        const rows = sqlite.prepare(`SELECT * FROM "${table}" WHERE id > ? ORDER BY id LIMIT 100`).all(afterId)
        if (!rows.length) return
        yield rows.map(row => normalizedLegacyRow(row, table === 'systemPrompt' ? systemPrompt : aiGatewayLog, table === 'systemPrompt' ? generationJsonFields : gatewayJsonFields))
        afterId = Number(rows.at(-1)!.id)
    }
}

export function inspectLegacySqlite(sqlitePath: string): LegacyImportSummary {
    const sqlite = new DatabaseSync(sqlitePath, {readOnly: true})
    try {
        let generations = 0
        let gatewayLogs = 0
        for (const rows of legacyRows(sqlite, 'systemPrompt')) generations += rows.length
        for (const rows of legacyRows(sqlite, 'aiGatewayLog')) gatewayLogs += rows.length
        return {generations, gatewayLogs}
    } finally { sqlite.close() }
}

export async function importLegacySqlite(sqlitePath: string, db: NodePgDatabase): Promise<LegacyImportSummary> {
    const sqlite = new DatabaseSync(sqlitePath, {readOnly: true})
    try {
        return await db.transaction(async tx => {
            // Prevent a parallel request/import from populating an empty target
            // after the emptiness check. Any failure rolls back the entire copy.
            await tx.execute(sql`LOCK TABLE ${systemPrompt}, ${aiGatewayLog} IN ACCESS EXCLUSIVE MODE`)
            const [existingGeneration] = await tx.select({id: systemPrompt.id}).from(systemPrompt).limit(1)
            const [existingLog] = await tx.select({id: aiGatewayLog.id}).from(aiGatewayLog).limit(1)
            if (existingGeneration || existingLog) throw new LegacyImportError('Target PostgreSQL must have empty generation and Gateway-log tables.')
            let generations = 0
            let gatewayLogs = 0
            for (const rows of legacyRows(sqlite, 'systemPrompt')) {
                await tx.insert(systemPrompt).values(rows as NewSystemPrompt[])
                generations += rows.length
            }
            for (const rows of legacyRows(sqlite, 'aiGatewayLog')) {
                await tx.insert(aiGatewayLog).values(rows as NewAiGatewayLog[])
                gatewayLogs += rows.length
            }
            // PostgreSQL sequence setval changes survive transaction rollback.
            // ALTER SEQUENCE RESTART is transactional, so sequences and copied
            // rows stay consistent even when an import fails before commit.
            for (const [table, sequence] of [[systemPrompt, 'systemPrompt_id_seq'], [aiGatewayLog, 'aiGatewayLog_id_seq']] as const) {
                const [result] = await tx.select({value: sql<number>`coalesce(max(${table.id}), 0)`}).from(table)
                const nextId = Number(result?.value ?? 0) + 1
                if (!Number.isSafeInteger(nextId) || nextId > 2_147_483_647) throw new LegacyImportError('Legacy sequence exceeds PostgreSQL integer capacity.')
                await tx.execute(sql`ALTER SEQUENCE ${sql.identifier(sequence)} RESTART WITH ${sql.raw(String(nextId))}`)
            }
            return {generations, gatewayLogs}
        })
    } finally { sqlite.close() }
}
