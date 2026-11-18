import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {formatUsdUnits, parseUsdUnits} from '../../schemas/account-billing'
import {fallbackTranslator, type Translate} from './uiMessage'

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

const englishPriceLabels = fallbackTranslator({
  'account.price.confirmed': '{amount} · confirmed',
  'account.price.estimate': '{amount} · estimate, final price pending',
  'account.price.pending': 'Price pending confirmation',
})

// Components pass their `t` from useI18n() so the label follows the active
// language; the English fallback keeps plain node callers working.
export function generationPriceLabel(row: GenerationPrice, t: Translate = englishPriceLabels): string {
  const amount = formatUsd(row.priceUsd)
  if (hasConfirmedGenerationPrice(row)) return t('account.price.confirmed', {amount})
  return row.priceSource === 'estimate' && amount ? t('account.price.estimate', {amount}) : t('account.price.pending')
}
