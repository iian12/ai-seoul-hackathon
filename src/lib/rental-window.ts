// Internal aggregation policy, not a user-selectable filter.
export const RENTAL_WINDOW_MONTHS = 24
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
export function rentalWindowStart(periodEnd: string, months = RENTAL_WINDOW_MONTHS) {
  if (!validDate(periodEnd) || !Number.isSafeInteger(months) || months < 1) throw new Error('계약 집계 기간이 올바르지 않습니다.')
  const d = new Date(`${periodEnd}T00:00:00Z`), day = d.getUTCDate()
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}
