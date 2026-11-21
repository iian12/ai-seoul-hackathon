import { normalizeMetric } from './recommend.ts'
import type { Snapshot } from './types.ts'

export interface PercentileCalibration {
  method: 'percentile-v1'
  sampleCount: number
  knots: { value: number; score: number }[]
}
export type ScoreCalibration = PercentileCalibration | { p5: number; p95: number }

// Average ranks keep identical observations tied. Interpolation lets arbitrary map
// points use the same fixed citywide reference without rounding raw measurements.
export function calibrateScores(values: number[]): PercentileCalibration {
  if (!values.length || !values.every(Number.isFinite)) throw new Error('점수 기준에 유효한 관측값이 필요합니다.')
  const sorted = [...values].sort((a, b) => a - b)
  const knots: PercentileCalibration['knots'] = []
  for (let i = 0; i < sorted.length;) {
    let end = i + 1
    while (end < sorted.length && sorted[end] === sorted[i]) end++
    knots.push({ value: sorted[i], score: sorted.length === 1 ? 50 : 100 * (i + end - 1) / 2 / (sorted.length - 1) })
    i = end
  }
  return { method: 'percentile-v1', sampleCount: sorted.length, knots }
}

export function scoreMetric(value: number, calibration: ScoreCalibration): number {
  if (!Number.isFinite(value)) throw new Error('점수 관측값이 올바르지 않습니다.')
  if (!('method' in calibration)) return normalizeMetric(value, calibration.p5, calibration.p95).score
  const knots = calibration.knots
  if (!knots.length) throw new Error('점수 기준이 비어 있습니다.')
  if (knots.length === 1) return 50
  if (value <= knots[0].value) return knots[0].score
  if (value >= knots.at(-1)!.value) return knots.at(-1)!.score
  let low = 0, high = knots.length - 1
  while (high - low > 1) {
    const mid = (low + high) >>> 1
    if (knots[mid].value <= value) low = mid
    else high = mid
  }
  const a = knots[low], b = knots[high]
  return a.score + (b.score - a.score) * (value - a.value) / (b.value - a.value)
}

/** Recalibrate stored observations without changing facilities, routes or rents. */
export function applyPercentileScores(snapshot: Snapshot): void {
  const calculation = snapshot.calculation ??= {}
  const normalization: Record<string, PercentileCalibration> = {}
  const walking = snapshot.areas.some(a => a.walking)
  for (const key of ['safety', 'transit', 'medical'] as const) {
    const rows = snapshot.areas.filter(a => a.scores[key] != null && (key !== 'transit' || !walking || a.walking?.status === 'ok'))
    const calibration = calibrateScores(rows.map(a => a.metrics?.[`${key}Raw`] ?? NaN))
    normalization[key] = calibration
    for (const area of snapshot.areas) {
      if (rows.includes(area)) area.scores[key] = scoreMetric(area.metrics![`${key}Raw`], calibration)
      else area.scores[key] = null
    }
  }
  calculation.normalization = normalization
  if (walking) {
    calculation.transitNormalization = normalization.transit
    snapshot.modelVersion = snapshot.areas.every(a => a.scores.policing != null) ? 'seoul-five-domain-4.0' : 'seoul-percentile-3.0'
  }
  calculation.scoreNormalization = 'percentile-v1: citywide representative points; average ranks for ties; linear interpolation between observations; transit uses confirmed walking routes only; fixed before budget/location filtering'
  if (typeof calculation.transit === 'string') calculation.transit = calculation.transit.replace('clipped p5/p95 normalization', 'percentile-v1 normalization')
}
