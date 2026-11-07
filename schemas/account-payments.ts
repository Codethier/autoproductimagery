import {z} from 'zod'
import {parseUsdUnits, USD_SCALE, type AccountBalance} from './account-billing'

// Payments are received-money bookkeeping, separate from generation credit.
// Accept ordinary cents while preserving the ledger's exact twelve-place units.
export const MAX_ACCOUNT_PAYMENT_USD = 1_000_000
export const MAX_ACCOUNT_PAYMENT_UNITS = BigInt(MAX_ACCOUNT_PAYMENT_USD) * USD_SCALE
export const PaymentAmountSchema = z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/, 'Use a positive USD amount with up to two decimal places')
    .refine(value => {const units = parseUsdUnits(value); return units !== undefined && units > 0n && units <= MAX_ACCOUNT_PAYMENT_UNITS}, 'Use an amount between $0.01 and $1,000,000')
    .transform(value => {const units = parseUsdUnits(value)!; return `${units / USD_SCALE}.${((units % USD_SCALE) / 10_000_000_000n).toString().padStart(2, '0')}`})

export const RecordAccountPaymentSchema = z.object({
    amountUsd: PaymentAmountSchema,
    note: z.string().trim().max(500).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Use a valid payment note').default(''),
    idempotencyKey: z.uuid(),
}).strict()
export const AccountPaymentListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(1024).optional(),
}).strict()

export type AccountPaymentEvent = {
    id: string
    userId: string
    currency: 'USD'
    amountUsd: string
    note: string
    createdAt: string
    recordedBy: {id: string; displayName: string; username: string}
}
export type AccountPaymentList = {
    userId: string
    events: AccountPaymentEvent[]
    nextCursor: string | null
    balance: AccountBalance
}
export type RecordedAccountPayment = {event: AccountPaymentEvent; balance: AccountBalance; created: boolean}
export type RecordAccountPayment = z.infer<typeof RecordAccountPaymentSchema>
export type AccountPaymentListQuery = z.infer<typeof AccountPaymentListQuerySchema>
