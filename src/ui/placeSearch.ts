// 학교·직장 위치 검색 순위. 데이터(seoul-places.json)와 src/lib는 그대로 두고, 화면에서 보여줄 순서만 정한다.
import type { Place } from '../lib/location.ts'
import { isInSeoul } from '../lib/seoul.ts'
import { STATIONS } from './stations.ts'

const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, '')
const inSeoul = (p: Place) => isInSeoul(p.latitude, p.longitude)
export const stationPlaces: Place[] = STATIONS.map(station => ({
  id: `station-${station.name}`,
  name: station.name.endsWith('역') ? station.name : `${station.name}역`,
  address: station.lines.join(' · '),
  category: '지하철역',
  latitude: station.lat,
  longitude: station.lng,
}))

export function findStationPlace(query: string): Place | undefined {
  const name = norm(query).replace(/역$/, '')
  return stationPlaces.find(place => norm(place.name).replace(/역$/, '') === name && inSeoul(place))
}

function closeBy(a: Place, b: Place) {
  const dy = (a.latitude - b.latitude) * 111_000, dx = (a.longitude - b.longitude) * 88_000
  return dx * dx + dy * dy < 300 * 300
}

/**
 * 순서
 * 정확히 일치하는 역 → 입력으로 시작하는 법정동 → 대학 본 캠퍼스 → 정확한 이름
 * → 대학 건물 → 입력으로 시작하는 이름 → 주소를 포함해 일치하는 학교와 기타 장소.
 * "강남역"으로 검색할 때 이름이 "강남"인 일반 장소는 뺀다. 같은 순위면 짧은 이름이 먼저다.
 * 같은 이름이 300m 안에 여러 개면 하나만, 같은 첫 단어(예: "연세대학교 ○○관")는 3개까지만 보여준다.
 */
export function rankPlaces(index: Place[], query: string, limit = 12): Place[] {
  const q = norm(query)
  if (q.length < 2) return []
  const uni = q.endsWith('대') ? `${q}학교` : q.endsWith('대학교') ? q : ''
  const station = q.length > 2 && q.endsWith('역') ? q.slice(0, -1) : ''
  const scored: { p: Place; s: number; n: string }[] = []
  for (const p of index) {
    const n = norm(p.name)
    const full = norm(`${p.name} ${p.address}`)
    const area = p.category === '동네'
    const dong = area ? norm(p.name.split(' ').at(-1) ?? '') : ''
    let s = -1
    if (p.category === '지하철역' && n === q) s = 0
    else if (area && (dong.startsWith(q) || n.startsWith(q))) s = 1
    else if (uni && n.startsWith(uni) && p.category === '학교' && n.includes('캠퍼스')) s = 2
    else if (station && n === station) s = -1
    else if (n === q) s = 3
    else if (uni && n.startsWith(uni) && p.category === '학교') s = 4
    else if (n.startsWith(q) || (uni && n.startsWith(uni))) s = 5
    else if (full.includes(q)) s = p.category === '학교' ? 6 : 7
    if (s >= 0 && (area || inSeoul(p))) scored.push({ p, s, n })
  }
  scored.sort((a, b) => a.s - b.s || a.p.name.length - b.p.name.length || a.p.id.localeCompare(b.p.id))
  const out: Place[] = []
  const perHead = new Map<string, number>()
  for (const { p } of scored) {
    if (out.some(o => norm(o.name) === norm(p.name) && closeBy(o, p))) continue
    const head = p.category === '동네' ? p.id : norm(p.name.split(' ')[0])
    const used = perHead.get(head) ?? 0
    if (p.name.includes(' ') && used >= 3) continue
    perHead.set(head, used + 1)
    out.push(p)
    if (out.length === limit) break
  }
  return out
}
