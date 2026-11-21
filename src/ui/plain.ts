// 화면용 쉬운 말 변환 모음. 계산 로직(src/lib)은 건드리지 않고, 이미 받은 숫자를 문장으로만 바꾼다.
import type { Area, Domain, Recommendation, Weights } from '../lib/types.ts'

export const presetLabels: Record<string, string> = {
  balanced: '골고루 다 중요해요',
  safety: '안전이 중요해요',
  policing: '치안이 중요해요',
  transit: '출퇴근·통학이 길어요',
  housing: '월세를 아끼고 싶어요',
  medical: '병원이 가까워야 해요',
}

/** 전세일 때는 '월세' 대신 '보증금'으로 말한다. */
export const presetLabel = (id: string, jeonse: boolean, fallback = '') =>
  id === 'housing' && jeonse ? '보증금 부담을 줄이고 싶어요' : presetLabels[id] ?? fallback

export const weightLabels: Record<Domain, string> = { policing: '치안', safety: '안전시설', transit: '교통', housing: '주거비 부담 줄이기', medical: '병원·약국' }
export const weightHints: Record<Domain, string> = {
  policing: '자치구 범죄 발생률이 상대적으로 낮은지',
  safety: '안심귀갓길 CCTV·안심벨 등이 가까이 많은지',
  transit: '지하철역·버스정류장이 가까운지',
  housing: '예산에 맞는 집이 많은지',
  medical: '병원·약국·응급실이 가까운지',
}

export const levels = [
  { id: 'low', label: '덜 중요', value: 10 },
  { id: 'mid', label: '보통', value: 25 },
  { id: 'high', label: '중요', value: 50 },
] as const
export type LevelId = typeof levels[number]['id']
export const levelOf = (value: number): LevelId => value >= 40 ? 'high' : value >= 18 ? 'mid' : 'low'

/** 쉼표·공백을 지운 숫자 문자열 */
export const cleanNumber = (s: string) => s.replace(/[,\s]/g, '')

/** 만원 단위 입력을 "1억 2,000만 원"처럼 읽기 쉬운 말로 */
export function manwonLabel(input: string): string {
  const s = cleanNumber(input)
  if (!/^\d+$/.test(s)) return ''
  const n = Number(s)
  if (!Number.isSafeInteger(n)) return ''
  if (n === 0) return '0원'
  const eok = Math.floor(n / 10000), man = n % 10000
  return `${eok ? `${eok.toLocaleString('ko-KR')}억` : ''}${eok && man ? ' ' : ''}${man ? `${man.toLocaleString('ko-KR')}만` : ''} 원`
}

/** 원 단위 금액을 "60만 원", "3억 원"으로 */
export function krwLabel(krw: number): string {
  return manwonLabel(String(Math.round(krw / 10000)))
}

export function walkMinutes(area: Area): number | null {
  const w = area.walking
  return w?.status === 'ok' && w.durationSeconds != null ? Math.max(1, Math.round(w.durationSeconds / 60)) : null
}

/** 예산 적합 비율을 "열 집 중 3집꼴"로 */
export function oneInTen(ratio: number): string {
  if (ratio >= 0.95) return '거의 모든 집'
  const n = Math.round(ratio * 10)
  return n >= 1 ? `열 집 중 ${n}집꼴` : '스무 집 중 1집꼴 이하'
}

const reasonDomains: Domain[] = ['safety', 'policing', 'transit', 'medical', 'housing']

/** 문장 고르기용 점수. 주거비는 적합 비율 기준으로 다시 본다(점수 계산에는 쓰지 않음). */
function goodness(r: Recommendation, k: Domain) {
  return k === 'housing' ? Math.min(100, r.matchRatio * 200) : (r.componentScores[k] ?? 0)
}

function phrase(k: Domain, r: Recommendation, positive: boolean): string {
  const m = r.area.metrics ?? {}
  if (k === 'transit') {
    const min = walkMinutes(r.area)
    if (positive) return min ? `지하철역까지 걸어서 약 ${min}분이에요` : '대중교통 이용이 편한 편이에요'
    return min ? `지하철역까지 걸어서 ${min}분 정도 걸려요` : '대중교통 접근성은 아쉬운 편이에요'
  }
  if (k === 'policing') return `${r.area.crime?.year ?? ''}년 ${r.area.district}의 자치구 범죄 발생률이 서울 비교에서 ${positive ? '낮은' : '높은'} 편이에요 (동별 수치 아님)`
  if (k === 'safety') {
    const n = m.observedSafety500m
    if (positive) return n != null ? `안심귀갓길 안전시설이 주변 500m에 ${n}곳 있어요` : '안전시설이 많은 편이에요'
    return n != null ? `주변 안심귀갓길 안전시설은 ${n}곳으로 적은 편이에요` : '안전시설은 적은 편이에요'
  }
  if (k === 'medical') {
    const h = m.hospitals500m, p = m.pharmacies500m
    if (positive) return h != null && p != null ? `대표점 직선 500m 안에 병·의원 ${h}곳, 약국 ${p}곳이 있어요` : '병원·약국이 가까운 편이에요'
    return h != null ? `가까운 병·의원은 ${h}곳으로 적은 편이에요` : '병원·약국은 조금 먼 편이에요'
  }
  if (positive) return r.matchRatio >= 0.95 ? '이 동네 거래는 거의 모두 예산 안에 들어와요' : `예산에 맞는 집이 ${oneInTen(r.matchRatio)}로 많은 편이에요`
  const share = oneInTen(r.matchRatio)
  return `예산에 맞는 집은 ${share}${share.endsWith('하') ? '라' : '이라'} 발품이 필요해요`
}

export function strengthsOf(r: Recommendation) {
  const ranked = [...reasonDomains].sort((a, b) => goodness(r, b) - goodness(r, a))
  const strengths = ranked.filter(k => goodness(r, k) >= 50).slice(0, 2)
  const weakest = ranked.at(-1)!
  const weakness = goodness(r, weakest) < 40 && !strengths.includes(weakest) ? weakest : null
  return { strengths: strengths.length ? strengths : ranked.slice(0, 1), weakness }
}

/** 추천 이유 한두 문장: 강점 2개 + 아쉬운 점 1개 */
export function reasonFor(r: Recommendation): string {
  const { strengths, weakness } = strengthsOf(r)
  const parts = strengths.map(k => `${phrase(k, r, true)}.`)
  if (weakness) parts.push(`다만 ${phrase(weakness, r, false)}.`)
  return parts.join(' ')
}

const fitFor: Record<Domain, string> = {
  policing: '자치구 범죄 통계를 중요하게 보는 분',
  safety: '귀갓길 안전시설을 중요하게 보는 분',
  transit: '출퇴근·통학이 잦은 분',
  medical: '병원·약국을 자주 이용하는 분',
  housing: '월세 부담을 줄이고 싶은 분',
}
const fitForJeonseHousing = '보증금 부담을 줄이고 싶은 분'
const checkFor: Record<Domain, string> = {
  policing: '구 전체 통계이므로 집 주변 상황은 직접 확인해 보세요',
  safety: '밤 시간에 집에서 역까지 직접 걸어 보세요',
  transit: '출퇴근 시간대 실제 이동 시간을 확인해 보세요',
  medical: '자주 가는 병원까지의 거리를 확인해 보세요',
  housing: '예산에 맞는 매물이 지금도 있는지 부동산에 먼저 물어보세요',
}
/** 카드 상세의 '이런 분께 맞아요 / 확인해 보세요'. 아쉬운 점이 없으면 확인 문구는 비워 둔다(모든 카드에 같은 말 반복 방지). */
export function fitLines(r: Recommendation, jeonse = false) {
  const { strengths, weakness } = strengthsOf(r)
  return { fit: strengths.map(k => k === 'housing' && jeonse ? fitForJeonseHousing : fitFor[k]).join(', '), check: weakness ? checkFor[weakness] : null }
}

export interface LifeFact { key: string; text: string }
/** 상세 화면의 생활 언어 요약. 스냅샷에 이미 들어 있는 metrics 숫자만 사용한다. */
export function lifeFacts(area: Area): LifeFact[] {
  const m = area.metrics
  if (!m) return []
  const facts: LifeFact[] = []
  if (area.crime) facts.push({ key: 'crime', text: `${area.crime.year}년 ${area.crime.district} 전체 범죄: 주민등록인구 10만 명당 ${area.crime.per100k.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}건 · 자치구 통계, 동별 수치 아님 (교통범죄 등 포함)` })
  const min = walkMinutes(area)
  if (min != null) facts.push({ key: 'walk', text: `지하철역까지 걸어서 약 ${min}분 (${Math.round(area.walking!.distanceM ?? 0)}m)` })
  else if (m.stationDistanceM != null) facts.push({ key: 'walk', text: `지하철역까지 직선으로 약 ${Math.round(m.stationDistanceM)}m` })
  if (m.busDistanceM != null) facts.push({ key: 'bus', text: `버스정류장까지 직선으로 약 ${Math.round(m.busDistanceM)}m` })
  if (m.hospitals500m != null || m.pharmacies500m != null) facts.push({ key: 'medical', text: `500m 안 병·의원 ${m.hospitals500m ?? 0}곳 · 약국 ${m.pharmacies500m ?? 0}곳` })
  if (m.nightPharmacies1000m != null) facts.push({ key: 'night', text: `1km 안 야간 운영시간이 공시된 약국 ${m.nightPharmacies1000m}곳 (현재 영업 미확인)` })
  if (m.sundayPharmacies1000m != null) facts.push({ key: 'sunday', text: `1km 안 일요일 운영시간 공시 약국 ${m.sundayPharmacies1000m}곳` })
  if (m.weekendHospitals1000m != null) facts.push({ key: 'weekend', text: `1km 안 주말 진료시간 공시 병·의원 ${m.weekendHospitals1000m}곳` })
  if (m.cctv500m != null) facts.push({ key: 'public-cctv', text: `500m 안 공공 방범 CCTV ${m.cctv500m}지점 (카메라 대수와 다름)` })
  if (m.bell500m != null) facts.push({ key: 'bell', text: `500m 안 안전비상벨 ${m.bell500m}지점` })
  if (m.convenience500m != null) facts.push({ key: 'stores', text: `500m 안 편의점 ${m.convenience500m}곳 · 식료품·마트 ${m.grocery500m}곳 · 세탁 ${m.laundry500m}곳 (실시간 영업 미확인)` })
  if (m.emergencyDistanceM != null) facts.push({ key: 'emergency', text: `응급실까지 직선으로 약 ${(m.emergencyDistanceM / 1000).toFixed(1)}km` })
  if (m.observedSafety500m != null) facts.push({ key: 'safety', text: `500m 안 안전시설 ${m.observedSafety500m}곳 (안심귀갓길${m.observedCctv500m != null ? `, 그중 CCTV ${m.observedCctv500m}곳` : ''})` })
  return facts
}

export type ReasonKey = 'budget' | 'radius' | 'walk' | 'data' | 'outside' | 'other'
export const reasonTitles: Record<ReasonKey, string> = {
  budget: '예산 조건을 충족하지 못했어요',
  radius: '학교·직장 기준 반경 밖이에요',
  walk: '역까지 걷는 시간 정보가 없어 비교에서 뺐어요',
  data: '비교에 필요한 시설 정보가 부족해요',
  outside: '서울 밖 지역이에요',
  other: '기타',
}
export const reasonShort: Record<ReasonKey, string> = { budget: '예산 부족', radius: '반경 밖', walk: '도보 정보 없음', data: '시설 정보 부족', outside: '서울 밖', other: '기타' }
/** recommend.ts가 만든 제외 사유 문장을 쉬운 말로 바꾼다(원문은 바꾸지 않음). */
export function plainReason(reason: string): { key: ReasonKey; text: string } {
  const m = reason.match(/충족 (\d+)건/)
  if (m) return { key: 'budget', text: m[1] === '0' ? '예산에 맞는 거래가 없어요' : `예산에 맞는 거래가 ${m[1]}건뿐이라 비교가 어려워요` }
  if (reason.includes('반경')) return { key: 'radius', text: reasonTitles.radius }
  if (reason.includes('보행')) return { key: 'walk', text: reasonTitles.walk }
  if (reason.includes('필수')) return { key: 'data', text: reasonTitles.data }
  if (reason.includes('서울 외')) return { key: 'outside', text: reasonTitles.outside }
  return { key: 'other', text: reason }
}

export const sameWeights = (a: Weights, b: Weights) => (Object.keys(a) as Domain[]).every(k => a[k] === b[k])

/** 화면 어디서나 같은 순서: 주거비 → 교통 → 병원·약국 → 안전시설 (카드·비교표·리포트 점수·생활 정보) */
export const uiOrder: Domain[] = ['housing', 'transit', 'medical', 'safety', 'policing']
/** 사용자가 더 중요하게 고른 항목(비중 30% 이상). 골고루면 강조하지 않는다. */
export const emphasisOf = (w: Weights): Domain[] => uiOrder.filter(k => (w[k] ?? 0) >= .3)

export interface CardFact { key: Domain; label: string; value: string }
/** 결과 카드의 비교 줄: 모든 동네가 같은 순서·같은 단위 */
export function cardFacts(r: Recommendation, jeonse: boolean): CardFact[] {
  const m = r.area.metrics ?? {}
  const min = walkMinutes(r.area)
  const n = (v: number | undefined) => v != null && Number.isFinite(v) ? `${Math.round(v)}곳` : '-'
  return [
    { key: 'housing', label: jeonse ? '전세 중간값' : '월세 중간값', value: krwLabel(jeonse ? r.medianDepositKrw ?? 0 : r.medianRentKrw) },
    { key: 'housing', label: '예산 맞는 집', value: oneInTen(r.matchRatio) },
    { key: 'transit', label: '역까지 도보', value: min != null ? `약 ${min}분` : '-' },
    { key: 'medical', label: '500m 안 병원·약국', value: `병·의원 ${n(m.hospitals500m)} · 약국 ${n(m.pharmacies500m)}` },
    { key: 'safety', label: '500m 안 안전시설', value: n(m.observedSafety500m) },
  ]
}
