import { domains } from './types.ts'
import { isInSeoul, SEOUL_DISTRICTS } from './seoul.ts'
import type { Area, Budget, LeaseType, LocationFilter, Recommendation, RecommendationOrder, Results, Scores, Snapshot, Transaction, Weights } from './types.ts'
import { validateLocation, withinRadius } from './location.ts'
import { validDate } from './rental-window.ts'
import { validateCrime } from './crime.ts'

export const MODEL_VERSION = 'mvp-1.0'
export const SUPPORTED_MODELS = [MODEL_VERSION, 'seoul-observed-1.0', 'seoul-walking-1.0', 'seoul-enriched-2.0', 'seoul-percentile-3.0', 'seoul-five-domain-4.0']
export const MIN_SAMPLES = 10
export const DEFAULT_WEIGHTS: Weights = { safety: 20, transit: 20, housing: 20, medical: 20, policing: 20 }
export const presets: { id: string; name: string; weights: Weights }[] = [
  { id: 'balanced', name: '균형 있게', weights: DEFAULT_WEIGHTS },
  { id: 'policing', name: '치안 우선', weights: { policing: 50, safety: 10, transit: 15, housing: 15, medical: 10 } },
  { id: 'safety', name: '안전시설 우선', weights: { policing: 10, safety: 50, transit: 15, housing: 15, medical: 10 } },
  { id: 'transit', name: '교통 우선', weights: { policing: 10, safety: 10, transit: 50, housing: 20, medical: 10 } },
  { id: 'housing', name: '주거비 우선', weights: { policing: 10, safety: 10, transit: 20, housing: 50, medical: 10 } },
  { id: 'medical', name: '의료 우선', weights: { policing: 10, safety: 10, transit: 10, housing: 20, medical: 50 } },
]
const clamp = (x: number) => Math.max(0, Math.min(100, x))
export function normalizeWeights(weights: Weights): { weights: Record<typeof domains[number], number>; reset: boolean } {
  if (domains.some(k => !Number.isFinite(weights[k] ?? 0) || (weights[k] ?? 0) < 0 || (weights[k] ?? 0) > 100)) throw new Error('중요도는 0~100 사이로 설정해 주세요.')
  const sum = domains.reduce((a, k) => a + (weights[k] ?? 0), 0)
  return { weights: Object.fromEntries(domains.map(k => [k, sum ? (weights[k] ?? 0) / sum : 1 / domains.length])) as Record<typeof domains[number], number>, reset: sum === 0 }
}
export function parseBudget(deposit: string, rent: string, leaseType: LeaseType = 'monthly'): Budget {
  if (!['monthly', 'jeonse'].includes(leaseType)) throw new Error('전세 또는 월세를 선택해 주세요.')
  const parse = (s: string, max: number, label: string) => {
    if (!/^\d+$/.test(s.trim())) throw new Error(`${label}을 0 이상의 정수로 입력해 주세요.`)
    const value = Number(s) * 10000
    if (!Number.isSafeInteger(value) || value > max) throw new Error(`${label} 입력 범위를 확인해 주세요.`)
    return value
  }
  return { maxDepositKrw: parse(deposit, 10_000_000_000, '보증금'), maxMonthlyRentKrw: leaseType === 'jeonse' ? 0 : parse(rent, 100_000_000, '월세'), ...(leaseType === 'jeonse' ? { leaseType } : {}) }
}
export function isValidTransaction(t: Transaction, snapshot: Snapshot, leaseType: LeaseType = 'monthly') {
  return t.leaseType === leaseType && Number.isSafeInteger(t.depositKrw) && (leaseType === 'jeonse' ? t.depositKrw > 0 : t.depositKrw >= 0) &&
    Number.isSafeInteger(t.monthlyRentKrw) && (leaseType === 'jeonse' ? t.monthlyRentKrw === 0 : t.monthlyRentKrw > 0) && Number.isFinite(t.areaM2) && t.areaM2 > 0 &&
    Boolean(t.housingType?.trim()) && validDate(t.contractDate) && t.contractDate >= snapshot.periodStart && t.contractDate <= snapshot.periodEnd
}
export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2
}
export function weightedScore(scores: Scores, normalized: Weights) {
  return domains.reduce((total, k) => total + (scores[k] ?? 0) * (normalized[k] ?? 0), 0)
}
export function compareRecommendations(a: Recommendation, b: Recommendation) {
  return b.totalScore - a.totalScore || b.matchRatio - a.matchRatio || b.sampleCount - a.sampleCount || (a.area.code < b.area.code ? -1 : a.area.code > b.area.code ? 1 : 0)
}
export function normalizeMetric(value: number, p5: number, p95: number, lowerIsBetter = false) {
  if (![value, p5, p95].every(Number.isFinite) || p95 < p5) throw new Error('정규화 기준이 올바르지 않습니다.')
  if (p5 === p95) return { score: 50, flag: 'constant_distribution' }
  const score = clamp(100 * (value - p5) / (p95 - p5))
  return { score: lowerIsBetter ? 100 - score : score, flag: null }
}
export function recommend(snapshot: Snapshot, budget: Budget, inputWeights: Weights, locationFilter?: LocationFilter, order: RecommendationOrder = 'score'): Results {
  if (!SUPPORTED_MODELS.includes(snapshot.modelVersion)) throw new Error('지원하지 않는 점수 모델입니다. 데이터 버전을 확인해 주세요.')
  if ([budget.maxDepositKrw, budget.maxMonthlyRentKrw].some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('예산은 0 이상의 원화 정수여야 합니다.')
  const leaseType = budget.leaseType ?? 'monthly'
  if (!['monthly', 'jeonse'].includes(leaseType) || (leaseType === 'jeonse' && budget.maxMonthlyRentKrw !== 0)) throw new Error('전세 예산은 보증금 상한만 적용합니다.')
  const { weights, reset } = normalizeWeights(inputWeights)
  if (locationFilter) validateLocation(locationFilter)
  if (!['score', 'budget-fit'].includes(order)) throw new Error('정렬 기준이 올바르지 않습니다.')
  const excluded: Results['excluded'] = []
  const candidates: Recommendation[] = []
  for (const area of snapshot.areas) {
    if (!SEOUL_DISTRICTS.has(area.district) || !isInSeoul(area.latitude, area.longitude)) { excluded.push({ area, reason: '서울 외 지역' }); continue }
    if (locationFilter && !withinRadius(area, locationFilter)) { excluded.push({ area, reason: `기준 위치 반경 ${locationFilter.radiusKm}km 밖 · 대표점 직선거리` }); continue }
    if (['seoul-walking-1.0', 'seoul-enriched-2.0', 'seoul-percentile-3.0', 'seoul-five-domain-4.0'].includes(snapshot.modelVersion) && area.walking?.status !== 'ok') { excluded.push({ area, reason: '보행 네트워크에서 역 출입구까지 경로 미확인' }); continue }
    if (snapshot.modelVersion === 'seoul-five-domain-4.0' && (!area.crime || area.scores.policing == null)) { excluded.push({ area, reason: '치안 통계 미확인' }); continue }
    const missing = (['safety', 'transit', 'medical'] as const).filter(k => area.scores[k] == null || !Number.isFinite(area.scores[k]) || area.scores[k]! < 0 || area.scores[k]! > 100)
    if (missing.length) { excluded.push({ area, reason: '필수 영역 데이터 미충족' }); continue }
    const valid = area.transactions.filter(t => isValidTransaction(t, snapshot, leaseType))
    const groups = [...valid.map(t => ({ depositKrw: t.depositKrw, monthlyRentKrw: t.monthlyRentKrw, count: 1 })), ...(leaseType === 'jeonse' ? (area.jeonseGroups ?? []).map(g => ({ ...g, monthlyRentKrw: 0 })) : area.rentalGroups ?? [])]
    const sampleCount = groups.reduce((s, g) => s + g.count, 0)
    const matching = groups.filter(t => t.depositKrw <= budget.maxDepositKrw && t.monthlyRentKrw <= budget.maxMonthlyRentKrw)
    const matchCount = matching.reduce((s, g) => s + g.count, 0)
    if (matchCount < MIN_SAMPLES) { excluded.push({ area, reason: `${leaseType === 'jeonse' ? '전세 보증금 충족' : '예산 동시 충족'} ${matchCount}건 · 최소 ${MIN_SAMPLES}건 필요` }); continue }
    const medianRentKrw = weightedMedian(groups.map(g => ({ value: g.monthlyRentKrw, count: g.count })))
    const matchRatio = matchCount / sampleCount
    // Neighborhood medians affect housing headroom, not candidate eligibility.
    const medianDepositKrw = weightedMedian(groups.map(g => ({ value: g.depositKrw, count: g.count })))
    const limit = leaseType === 'jeonse' ? budget.maxDepositKrw : budget.maxMonthlyRentKrw
    const headroom = limit > 0 ? clamp(100 * (limit - (leaseType === 'jeonse' ? medianDepositKrw : medianRentKrw)) / limit) : 0
    const componentScores: Scores = { policing: area.scores.policing ?? (snapshot.isDemo ? 50 : 0), safety: area.scores.safety!, transit: area.scores.transit!, medical: area.scores.medical!, housing: 60 * matchRatio + .4 * headroom }
    candidates.push({ area, rank: 0, totalScore: weightedScore(componentScores, weights), componentScores, budgetMatchCount: matchCount, sampleCount, matchRatio, medianRentKrw, matchedMedianRentKrw: weightedMedian(matching.map(g => ({ value: g.monthlyRentKrw, count: g.count }))), matchedMedianDepositKrw: weightedMedian(matching.map(g => ({ value: g.depositKrw, count: g.count }))), ...(leaseType === 'jeonse' ? { medianDepositKrw } : {}) })
  }
  const warnings = [...snapshot.warnings]
  if (leaseType === 'jeonse' && !snapshot.areas.some(a => a.jeonseGroups?.length || a.transactions.some(t => t.leaseType === 'jeonse'))) warnings.push('현재 스냅샷에 전세 표본이 없습니다. 전세 집계가 포함된 서울 실제 데이터를 불러와 주세요.')
  if (reset) warnings.push('중요도 합계가 0이어서 균형형으로 계산했습니다.')
  if (candidates.length < 3) warnings.push(candidates.length ? `조건에 맞는 지역이 ${candidates.length}곳입니다.` : `예산${locationFilter ? '·반경' : ''}과 최소 표본 조건을 만족하는 지역이 없습니다. ${locationFilter ? '반경을 넓히거나 ' : ''}${leaseType === 'jeonse' ? '전세 보증금' : '보증금 또는 월세'} 상한을 높여 다시 확인해 보세요.`)
  return { recommendations: candidates.sort(order === 'budget-fit' ? (a, b) => b.matchRatio - a.matchRatio || compareRecommendations(a, b) : compareRecommendations).slice(0, 3).map((r, i) => ({ ...r, rank: i + 1 })), effectiveWeights: weights, warnings, excluded, candidateCount: candidates.length, budget, order, ...(locationFilter ? { locationFilter: { ...locationFilter } } : {}) }
}

// Public snapshots must be validated at the trust boundary before rendering or scoring.
export function validateSnapshot(value: unknown): asserts value is Snapshot {
  const s = value as Snapshot
  if (!s || typeof s.id !== 'string' || !SUPPORTED_MODELS.includes(s.modelVersion) || typeof s.isDemo !== 'boolean' || typeof s.spatialUnit !== 'string' || !Array.isArray(s.areas) || !s.areas.length || !Array.isArray(s.sources) || !Array.isArray(s.warnings) || s.warnings.some(x => typeof x !== 'string')) throw new Error('스냅샷 형식 또는 모델 버전이 올바르지 않습니다.')
  for (const d of [s.createdAt, s.periodStart, s.periodEnd]) if (typeof d !== 'string' || !Number.isFinite(Date.parse(d))) throw new Error('자료 기준일이 올바르지 않습니다.')
  if (s.periodStart > s.periodEnd) throw new Error('자료 기간이 올바르지 않습니다.')
  if (s.availability && (!Array.isArray(s.availability) || s.availability.some(a => !a || typeof a.id !== 'string' || typeof a.name !== 'string' || !['complete', 'missing_key', 'unauthorized', 'failed', 'not_configured'].includes(a.status) || !Number.isFinite(Date.parse(a.checkedAt))))) throw new Error('보완 자료 상태가 올바르지 않습니다.')
  for (const source of s.sources) {
    if (!source || ['id', 'name', 'provider', 'license', 'observedDate', 'retrievedAt'].some(k => typeof source[k as keyof typeof source] !== 'string')) throw new Error('출처 정보가 부족합니다.')
    if (!/^https:\/\//.test(source.url)) throw new Error('출처 URL은 HTTPS여야 합니다.')
  }
  const codes = new Set<string>()
  for (const a of s.areas) {
    if (!a || typeof a.code !== 'string' || codes.has(a.code) || !a.name || !a.district || !a.scores || !Array.isArray(a.transactions) || !Array.isArray(a.evidence) || !Array.isArray(a.flags)) throw new Error('지역 데이터 형식이 올바르지 않습니다.')
    codes.add(a.code)
    if (a.crime) validateCrime(a.crime, a.district)
    if (s.modelVersion === 'seoul-five-domain-4.0' && (!a.crime || typeof a.scores.policing !== 'number' || !Number.isFinite(a.scores.policing) || a.scores.policing < 0 || a.scores.policing > 100)) throw new Error('치안 통계·점수 누락 또는 범위 오류')
    if (!SEOUL_DISTRICTS.has(a.district) || !isInSeoul(a.latitude, a.longitude)) throw new Error('서울 범위 밖 좌표 또는 자치구가 포함돼 있습니다.')
    for (const k of ['safety', 'transit', 'medical'] as const) if (a.scores[k] !== null && (typeof a.scores[k] !== 'number' || !Number.isFinite(a.scores[k]) || a.scores[k]! < 0 || a.scores[k]! > 100)) throw new Error('영역 점수 범위를 확인해 주세요.')
    for (const e of a.evidence) if (!e || typeof e.label !== 'string' || typeof e.value !== 'string' || !s.sources.some(src => src.id === e.sourceId)) throw new Error('지표의 출처 연결이 올바르지 않습니다.')
    for (const t of a.transactions) if (!t || typeof t !== 'object') throw new Error('거래 데이터 형식이 올바르지 않습니다.')
    if (a.walking?.status === 'ok') {
      const w = a.walking
      if (![w.distanceM, w.durationSeconds, w.originSnapM].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) || w.originSnapM! > 100 || !s.sources.some(src => src.id === w.sourceId)) throw new Error('도보 경로의 거리·시간·출처를 확인해 주세요.')
      if (w.destinationSnapM != null && (!Number.isFinite(w.destinationSnapM) || w.destinationSnapM < 0 || w.destinationSnapM > 20)) throw new Error('도보 도착점 보정 범위를 확인해 주세요.')
      if (!w.geometry || w.geometry.type !== 'LineString' || !Array.isArray(w.geometry.coordinates) || w.geometry.coordinates.length < 2 || w.geometry.coordinates.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new Error('도보 경로 선 좌표가 올바르지 않습니다.')
    }
    if (a.rentalGroups && (!Array.isArray(a.rentalGroups) || a.rentalGroups.some(g => !Number.isSafeInteger(g.depositKrw) || g.depositKrw < 0 || !Number.isSafeInteger(g.monthlyRentKrw) || g.monthlyRentKrw <= 0 || !Number.isSafeInteger(g.count) || g.count <= 0))) throw new Error('공동 예산 분포 집계 형식이 올바르지 않습니다.')
    if (a.jeonseGroups && (!Array.isArray(a.jeonseGroups) || a.jeonseGroups.some(g => !Number.isSafeInteger(g.depositKrw) || g.depositKrw <= 0 || !Number.isSafeInteger(g.count) || g.count <= 0))) throw new Error('전세 보증금 분포 집계 형식이 올바르지 않습니다.')
    if (a.boundary) {
      if (!['Polygon', 'MultiPolygon'].includes(a.boundary.type) || !Array.isArray(a.boundary.coordinates)) throw new Error('지원하지 않는 경계 형식입니다.')
      const polygons = a.boundary.type === 'Polygon' ? [a.boundary.coordinates] : a.boundary.coordinates
      if (!polygons.length || polygons.some(p => !Array.isArray(p) || !p.length || p.some(r => !Array.isArray(r) || r.length < 4 || r.some(v => !Array.isArray(v) || v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]))))) throw new Error('경계 좌표 형식이 올바르지 않습니다.')
    }
  }
}

export function weightedMedian(groups: { value: number; count: number }[]) {
  const sorted = [...groups].sort((a, b) => a.value - b.value)
  const count = sorted.reduce((n, g) => n + g.count, 0)
  const left = Math.floor((count - 1) / 2), right = Math.floor(count / 2)
  let cursor = 0, a = 0, b = 0
  for (const g of sorted) {
    if (cursor <= left && cursor + g.count > left) a = g.value
    if (cursor <= right && cursor + g.count > right) b = g.value
    cursor += g.count
  }
  return (a + b) / 2
}
