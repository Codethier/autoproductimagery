import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {formatUsdUnits, parseUsdUnits} from '../../schemas/account-billing'

export type GenerationPrice = {priceUsd?: string | null; priceSource?: string | null; billingState?: string | null}

export function formatUsd(value?: string | null): string {
  if (value == null || value === '') return ''
  const amount = parseUsdUnits(value)
  if (amount === undefined) return ''
  const [whole, fraction = ''] = formatUsdUnits(amount).split('.')
  // Keep every billed decimal, including tiny charges, while keeping normal
  // amounts readable. Exact billing must never be displayed as a rounded zero.
  return `$${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`
}

export function formatBalanceUsd(value?: string | null): string {
  if (value?.startsWith('-')) {
    const positive = formatUsd(value.slice(1))
    return positive ? `−${positive}` : ''
  }
  return formatUsd(value)
}

export function generationPriceLabel(row: GenerationPrice): string {
  const amount = formatUsd(row.priceUsd)
  if (hasConfirmedGenerationPrice(row)) return `${amount} · confirmed`
  return row.priceSource === 'estimate' && amount ? `${amount} · estimate, final price pending` : 'Price pending confirmation'
}
