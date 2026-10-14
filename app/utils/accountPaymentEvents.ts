import type {AccountPaymentEvent} from '../../schemas/account-payments'

function paymentTimestamp(value: string): string {
  // PostgreSQL returns six fractional places. Preserve them when merging a
  // replay with newer receipts; Date would collapse ties to milliseconds.
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,12}))?Z$/.exec(value)
  return parts ? `${parts[1]}.${(parts[2] ?? '').padEnd(12, '0')}` : value
}
export function mergeAccountPaymentEvents(previous: AccountPaymentEvent[], incoming: AccountPaymentEvent[]): AccountPaymentEvent[] {
  const unique = new Map(previous.map(event => [event.id, event]))
  for (const event of incoming) unique.set(event.id, event)
  return [...unique.values()].sort((left, right) => {
    const first = paymentTimestamp(left.createdAt), second = paymentTimestamp(right.createdAt)
    if (first !== second) return first > second ? -1 : 1
    return left.id === right.id ? 0 : left.id > right.id ? -1 : 1
  })
}
