import {z} from 'zod'

// Gateway image charges are stored to twelve decimal places. Convert strings
// directly to integer units: binary floating-point must never sum a balance.
export const USD_SCALE = 1_000_000_000_000n
export const MAX_USD_UNITS = 999_999_999_999_999_999_999_999n
const unsignedAmount = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/

export function parseUsdUnits(value: unknown): bigint | undefined {
    if (typeof value !== 'string' || !unsignedAmount.test(value)) return undefined
    const [whole, fraction = ''] = value.split('.')
    const units = BigInt(whole!) * USD_SCALE + BigInt(fraction.padEnd(12, '0'))
    return units <= MAX_USD_UNITS ? units : undefined
}

export function formatUsdUnits(units: bigint): string {
    const sign = units < 0n ? '-' : ''
    const absolute = units < 0n ? -units : units
    return `${sign}${absolute / USD_SCALE}.${(absolute % USD_SCALE).toString().padStart(12, '0')}`
}

export const UsdAmountSchema = z.string().refine(value => parseUsdUnits(value) !== undefined, 'Use a nonnegative USD amount with up to twelve decimal places')
    .transform(value => formatUsdUnits(parseUsdUnits(value)!))

export function allocateUsdUnits(total: bigint, index: number, count: number): bigint {
    if (total < 0n || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 0 || index >= count) throw new Error('Invalid charge allocation')
    const divisor = BigInt(count)
    return total / divisor + (BigInt(index) < total % divisor ? 1n : 0n)
}

export const SetAccountBalanceSchema = z.object({actualBalanceUsd: UsdAmountSchema.nullable()}).strict()
export type AccountBalance = {
    currency: 'USD'
    confirmedSpendUsd: string
    totalPaidUsd: string
    unpaidUsd: string
    overpaidUsd: string
    outstandingEstimateUsd: string
    outstandingCount: number
    outstandingUnknownCount: number
    actualBalanceUsd: string | null
    unlimited: boolean
    generationBlockedByOutstanding?: boolean
}
