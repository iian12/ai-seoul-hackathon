import { isInSeoul } from './seoul.ts'
import type { Area, LocationFilter } from './types.ts'

export interface Place { id: string; name: string; address: string; category: string; latitude: number; longitude: number }
const minRadiusKm = 0.5
const maxRadiusKm = 20
export const radiusRangeMessage = `반경은 ${minRadiusKm}~${maxRadiusKm}km로 설정해 주세요.`

export function isValidRadiusKm(radiusKm: number) {
  return Number.isFinite(radiusKm) && radiusKm >= minRadiusKm && radiusKm <= maxRadiusKm
}

export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))))
}
export function validateLocation(filter: LocationFilter) {
  if (!filter.name.trim() || !isInSeoul(filter.latitude, filter.longitude)) throw new Error('서울 안의 기준 위치를 선택해 주세요.')
  if (!isValidRadiusKm(filter.radiusKm)) throw new Error(radiusRangeMessage)
}
export function withinRadius(area: Area, filter: LocationFilter) { return distanceM(area, filter) <= filter.radiusKm * 1000 + 1e-6 }
const normalize = (s: string) => s.normalize('NFC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '')
export function searchPlaces(places: Place[], query: string): Place[] {
  const q = normalize(query)
  if (q.length < 2) return []
  const matches = places.filter(p => normalize(`${p.name} ${p.address}`).includes(q))
    .sort((a, b) => Number(normalize(b.name) === q) - Number(normalize(a.name) === q) || Number(normalize(b.name).startsWith(q)) - Number(normalize(a.name).startsWith(q)) || Number(b.category === '학교') - Number(a.category === '학교') || a.name.length - b.name.length || a.id.localeCompare(b.id))
  const results: Place[] = []
  for (const p of matches) {
    if (isInSeoul(p.latitude, p.longitude)) results.push(p)
    if (results.length === 12) break
  }
  return results
}
