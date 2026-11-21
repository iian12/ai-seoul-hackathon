import { validateExplanation, factualExplanation } from '../lib/explanation.ts'
import type { Explanation, ExplanationFact } from '../lib/explanation.ts'
export type { Explanation } from '../lib/explanation.ts'
// AI 기능(서버리스 함수 /api/*) 호출과 결과 검사. 점수·순위는 계산하지 않는다.
import { toDistrict } from './districts.ts'
import { presets, DEFAULT_WEIGHTS } from '../lib/recommend.ts'
import { domains } from '../lib/types.ts'
import type { Domain, LeaseType, LocationFilter, Weights } from '../lib/types.ts'
import { levels } from './plain.ts'
import { isValidRadiusKm, radiusRangeMessage } from '../lib/location.ts'
import type { Place } from '../lib/location.ts'

export class AiError extends Error {}
const FALLBACK = 'AI가 지금 응답하지 않아요. 잠시 후 다시 시도해 주세요.'

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response
  try { res = await fetch(`/api/${path}`, { method: 'POST', ...init }) }
  catch (e) { if (e instanceof DOMException && e.name === 'AbortError') throw e; throw new AiError('인터넷 연결을 확인해 주세요. AI 기능을 쓸 수 없어요.') }
  const data = await res.json().catch((error: unknown) => {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    return null
  }) as (T & { error?: string }) | null
  if (!res.ok || !data || data.error) throw new AiError(data?.error ?? FALLBACK)
  return data
}
const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })

/** 녹음한 소리 → 글 */
export async function transcribe(audio: Blob, signal?: AbortSignal) {
  const type = audio.type.split(';')[0] || 'audio/webm'
  const out = await call<{ text: string }>('transcribe', { headers: { 'Content-Type': type }, body: audio, signal })
  return out.text
}

type Level = 'low' | 'mid' | 'high'
interface RawParse { leaseType: LeaseType | null; depositManwon: number | null; rentManwon: number | null; situation: string | null; priorities: Record<Domain, Level | null>; districts?: unknown; place: string | null; radiusKm: number | null }
export interface ParsedConditions { leaseType?: LeaseType; deposit?: number; rent?: number; weights?: Weights; situation?: string; districts?: string[]; place?: string; radiusKm?: number }

const intIn = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined

/** 문장 → 조건. AI 답은 그대로 믿지 않고 범위를 다시 검사한다. */
export async function parseConditions(text: string, signal?: AbortSignal): Promise<ParsedConditions> {
  const raw = await call<RawParse>('parse', json({ text }, signal))
  if (raw.radiusKm != null && !isValidRadiusKm(raw.radiusKm)) throw new AiError(radiusRangeMessage)
  const leaseType = raw.leaseType === 'monthly' || raw.leaseType === 'jeonse' ? raw.leaseType : undefined
  const deposit = intIn(raw.depositManwon, 1_000_000)
  const rent = leaseType === 'jeonse' ? undefined : intIn(raw.rentManwon, 10_000)
  // 항목별로 분명히 말한 중요도가 있으면 그것을, 없으면 상황(프리셋)을 쓴다. 둘 다 없으면 지금 중요도를 그대로 둔다.
  const given = domains.filter(k => raw.priorities?.[k] === 'low' || raw.priorities?.[k] === 'mid' || raw.priorities?.[k] === 'high')
  let weights: Weights | undefined
  if (given.length) {
    const base = presets.find(p => p.id === raw.situation)?.weights ?? DEFAULT_WEIGHTS
    weights = Object.fromEntries(domains.map(k => [k, given.includes(k) ? levels.find(l => l.id === raw.priorities[k])!.value : base[k]])) as Weights
  } else if (raw.situation) {
    const p = presets.find(x => x.id === raw.situation)
    if (p) weights = { ...p.weights }
  }
  const place = typeof raw.place === 'string' && raw.place.trim() ? raw.place.trim().slice(0, 40) : undefined
  const radiusKm = raw.radiusKm == null ? undefined : Math.round(raw.radiusKm * 2) / 2
  const districts = Array.isArray(raw.districts) ? [...new Set(raw.districts.filter((d): d is string => typeof d === 'string').map(toDistrict).filter((d): d is string => !!d))].sort((a, b) => a.localeCompare(b, 'ko')) : []
  if (leaseType == null && deposit == null && rent == null && !weights && !place && radiusKm == null && !districts.length) throw new AiError('금액이나 상황을 알아듣지 못했어요. 예: "보증금 천만 원에 월세 육십, 밤늦게 퇴근해요"')
  const situation = presets.some(p => p.id === raw.situation) && !given.length ? raw.situation ?? undefined : undefined
  return { leaseType, deposit, rent, weights, situation, districts: districts.length ? districts : undefined, place, radiusKm }
}

export function resolveAiLocation(
  { place, radiusKm }: Pick<ParsedConditions, 'place' | 'radiusKm'>,
  current: LocationFilter | undefined,
  defaultRadiusKm: number,
  match?: Pick<Place, 'name' | 'latitude' | 'longitude'>,
): { filter: LocationFilter | undefined; warning: string } {
  if (place) {
    if (match) {
      const { name, latitude, longitude } = match
      return { filter: { name, latitude, longitude, radiusKm: radiusKm ?? defaultRadiusKm }, warning: '' }
    }
    const status = current
      ? `기존 조건을 유지했어요 (기준 위치 ‘${current.name}’, 반경 ${current.radiusKm}km).`
      : '기준 위치와 반경을 적용하지 않았어요.'
    return { filter: current, warning: `‘${place}’ 위치를 찾지 못했어요. ${status}` }
  }
  if (radiusKm == null) return { filter: current, warning: '' }
  if (!current) return { filter: undefined, warning: `반경 ${radiusKm}km를 적용하려면 기준 위치를 먼저 골라 주세요.` }
  return { filter: { ...current, radiusKm }, warning: '' }
}

export async function explainTop3(body: unknown, signal?: AbortSignal): Promise<Explanation> {
  const facts = (body as { recs: ExplanationFact[] }).recs
  try {
    const data = await call<Explanation>('explain', json(body, signal))
    return validateExplanation(data, facts) ? data : factualExplanation(facts)
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    return factualExplanation(facts)
  }
}

export async function guideScreen(body: { screen: string; facts: string[]; actions: string[] }, signal?: AbortSignal) {
  const out = await call<{ speech: string }>('guide', json(body, signal))
  return out.speech
}

/** 서울시청을 기준으로 한 방향·거리(지도 위치를 말로 설명할 때 쓴다). AI가 지리를 지어내지 않도록 화면에서 계산해 넘긴다. */
const CITY_HALL = { lat: 37.5663, lng: 126.9779 }
const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서']
export function fromCityHall(lat: number, lng: number) {
  const dy = (lat - CITY_HALL.lat) * 111.0, dx = (lng - CITY_HALL.lng) * 88.2
  const km = Math.hypot(dx, dy)
  if (km < 1) return '서울시청 근처'
  const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360
  return `서울시청에서 ${DIRS[Math.round(deg / 45) % 8]}쪽으로 약 ${km.toFixed(km < 10 ? 1 : 0)}km`
}
