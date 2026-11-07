import {and, eq, isNull, or, sql} from 'drizzle-orm'
import {systemPrompt} from '../db/schema'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'

export function confirmedGenerationPriceCondition() {
    return and(eq(systemPrompt.priceSource, 'gateway'),
        sql`${systemPrompt.priceUsd} ~ '^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,12})?$'`,
        or(isNull(systemPrompt.billingState), eq(systemPrompt.billingState, 'confirmed')),
        sql`COALESCE(${systemPrompt.usageJson}->'gatewayBilling'->>'isByok', 'false') <> 'true'`)
}

/** Internal rows retain storage paths for repair. Public projections hold
 * outputs until the final charge has reached durable storage. */
export function publicGeneration<T extends {outputImage?: string | null; priceUsd?: string | null; priceSource?: string | null; billingState?: string | null}>(row: T) {
    return {...row, outputImage: hasConfirmedGenerationPrice(row) ? row.outputImage : null}
}
