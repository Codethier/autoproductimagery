import {randomUUID} from 'node:crypto'
import {and, desc, eq, lt, or, sql} from 'drizzle-orm'
import {createError, getHeader, getRequestURL, readBody, setHeader, type H3Event} from 'h3'
import {z} from 'zod'
import {accountPayments, organizations, users} from '../db/schema'
import {getDatabase} from './lib/db'
import {createAccountBilling} from './accountBilling'
import type {AuthContext} from './accountSession'
import {assertRequestOrigin} from './requestOrigin'
import {installBoundedRawBody} from './boundedRequestBody'
import {formatUsdUnits, parseUsdUnits} from '../../schemas/account-billing'
import {AccountPaymentListQuerySchema, RecordAccountPaymentSchema, type AccountPaymentEvent, type AccountPaymentList, type RecordedAccountPayment} from '../../schemas/account-payments'

type Database = ReturnType<typeof getDatabase>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
const validId = z.uuid()
const CursorSchema = z.object({version: z.literal(1), organizationId: validId, userId: validId, id: validId,
    createdAt: z.iso.datetime({precision: 6})}).strict()
const selection = {id: accountPayments.id, userId: accountPayments.userId, amountUnits: accountPayments.amountUnits, note: accountPayments.note,
    recordedByUserId: accountPayments.recordedByUserId, recordedByDisplayName: accountPayments.recordedByDisplayName,
    recordedByUsername: accountPayments.recordedByUsername,
    // Never truncate PostgreSQL microseconds through Date before keyset paging.
    createdAt: sql<string>`to_char(${accountPayments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`}
type PaymentRow = {id: string; userId: string; amountUnits: string; note: string; recordedByUserId: string; recordedByDisplayName: string; recordedByUsername: string; createdAt: string}
function eventFor(row: PaymentRow): AccountPaymentEvent {
    return {id: row.id, userId: row.userId, currency: 'USD', amountUsd: formatUsdUnits(BigInt(row.amountUnits)), note: row.note, createdAt: row.createdAt,
        recordedBy: {id: row.recordedByUserId, displayName: row.recordedByDisplayName, username: row.recordedByUsername}}
}
function paymentScope(organizationId: string, userId: string) {return and(eq(accountPayments.organizationId, organizationId), eq(accountPayments.userId, userId))}
function decodeCursor(cursor: string | undefined, organizationId: string, userId: string) {
    if (cursor === undefined) return undefined
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024) throw new Error('Invalid cursor')
        const bytes = Buffer.from(cursor, 'base64url')
        if (bytes.toString('base64url') !== cursor) throw new Error('Invalid cursor')
        const parsed = CursorSchema.parse(JSON.parse(bytes.toString('utf8')))
        if (parsed.organizationId !== organizationId || parsed.userId !== userId) throw new Error('Invalid scope')
        return parsed
    } catch {throw createError({statusCode: 400, statusMessage: 'Invalid payment cursor'})}
}

export function privatePaymentResponse(event: H3Event) {
    setHeader(event, 'cache-control', 'private, no-store')
    setHeader(event, 'vary', 'Cookie')
}
export async function readPaymentBody(event: H3Event): Promise<unknown> {
    assertRequestOrigin(getHeader(event, 'origin'), getRequestURL(event, {xForwardedHost: false, xForwardedProto: true}).origin, getHeader(event, 'sec-fetch-site'))
    if (getHeader(event, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw createError({statusCode: 415, statusMessage: 'JSON request required'})
    await installBoundedRawBody(event, 4 * 1024)
    try {return await readBody(event)} catch {throw createError({statusCode: 400, statusMessage: 'Invalid payment request'})}
}

export function createAccountPayments(db: Database = getDatabase()) {
    const billing = createAccountBilling(db)
    async function authorizedTarget(tx: Transaction, actor: AuthContext, userId: string, ownerRequired: boolean) {
        if (!validId.safeParse(userId).success) throw createError({statusCode: 400, statusMessage: 'Invalid account'})
        // NO KEY UPDATE serializes role administration without blocking FK
        // reference checks held by a concurrently settling generation.
        const [organization] = await tx.select({id: organizations.id}).from(organizations).where(eq(organizations.id, actor.organizationId)).for('no key update').limit(1)
        const [current] = await tx.select({id: users.id, role: users.role, disabledAt: users.disabledAt, authVersion: users.authVersion,
            displayName: users.displayName, username: users.username}).from(users)
            .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId))).for('share').limit(1)
        if (!organization || !current || current.disabledAt || current.authVersion !== actor.authVersion) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
        if (ownerRequired && current.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
        if (!ownerRequired && userId !== current.id) throw createError({statusCode: 403, statusMessage: 'Your payment history is private'})
        // Do not UPDATE the recorder as well as the target. Key-share FK locks
        // remain compatible, including two owners recording one another.
        const [target] = await tx.select({creditBalanceUnits: users.creditBalanceUnits}).from(users)
            .where(and(eq(users.id, userId), eq(users.organizationId, actor.organizationId))).for('no key update').limit(1)
        if (!target) throw createError({statusCode: 404, statusMessage: 'User not found'})
        return {target, recorder: current}
    }
    async function list(tx: Transaction, actor: AuthContext, userId: string, input: unknown): Promise<AccountPaymentList> {
        const parsed = AccountPaymentListQuerySchema.safeParse(input)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid payment list request'})
        const {limit, cursor} = parsed.data, after = decodeCursor(cursor, actor.organizationId, userId)
        const rows = await tx.select(selection).from(accountPayments).where(and(paymentScope(actor.organizationId, userId), after ?
            or(lt(accountPayments.createdAt, after.createdAt), and(eq(accountPayments.createdAt, after.createdAt), lt(accountPayments.id, after.id))) : undefined))
            .orderBy(desc(accountPayments.createdAt), desc(accountPayments.id)).limit(limit + 1)
        const page = rows.slice(0, limit), last = page.at(-1)
        const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({version: 1, organizationId: actor.organizationId, userId, id: last.id, createdAt: last.createdAt})).toString('base64url') : null
        return {userId, events: page.map(eventFor), nextCursor, balance: await billing.balanceFor({organizationId: actor.organizationId, userId}, tx)}
    }
    async function listOwnPayments(actor: AuthContext, input: unknown = {}): Promise<AccountPaymentList> {
        return db.transaction(async tx => {await authorizedTarget(tx, actor, actor.userId, false); return list(tx, actor, actor.userId, input)})
    }
    async function listOrganizationUserPayments(actor: AuthContext, userId: string, input: unknown = {}): Promise<AccountPaymentList> {
        return db.transaction(async tx => {await authorizedTarget(tx, actor, userId, true); return list(tx, actor, userId, input)})
    }
    async function recordOrganizationUserPayment(actor: AuthContext, userId: string, input: unknown): Promise<RecordedAccountPayment> {
        const parsed = RecordAccountPaymentSchema.safeParse(input)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Use a positive USD amount with up to two decimals and an optional note of at most 500 characters'})
        const {amountUsd, note, idempotencyKey} = parsed.data, amountUnits = parseUsdUnits(amountUsd)!.toString()
        return db.transaction(async tx => {
            const {target, recorder} = await authorizedTarget(tx, actor, userId, true)
            const [existing] = await tx.select({...selection, idempotencyKey: accountPayments.idempotencyKey}).from(accountPayments)
                .where(and(paymentScope(actor.organizationId, userId), eq(accountPayments.idempotencyKey, idempotencyKey))).limit(1)
            let row: PaymentRow, created = false
            if (existing) {
                if (existing.amountUnits !== amountUnits || existing.note !== note) throw createError({statusCode: 409, statusMessage: 'This payment request was already used with different details'})
                row = existing
            } else {
                if (target.creditBalanceUnits !== null) throw createError({statusCode: 409, statusMessage: 'Payment events can only be added for Unlimited users'})
                const id = randomUUID()
                await tx.insert(accountPayments).values({id, organizationId: actor.organizationId, userId, recordedByUserId: recorder.id,
                    recordedByDisplayName: recorder.displayName, recordedByUsername: recorder.username, idempotencyKey, amountUnits, note})
                const [inserted] = await tx.select(selection).from(accountPayments).where(eq(accountPayments.id, id)).limit(1)
                if (!inserted) throw new Error('Payment was not recorded')
                row = inserted
                created = true
            }
            return {event: eventFor(row), created, balance: await billing.balanceFor({organizationId: actor.organizationId, userId}, tx)}
        })
    }
    return {listOwnPayments, listOrganizationUserPayments, recordOrganizationUserPayment}
}
