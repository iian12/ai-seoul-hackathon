// 지도에서 찍은 한 점의 생활 지표를 동 점수와 같은 식으로 다시 계산한다(브라우저 안에서만 계산, 서버로 보내지 않음).
// 데이터: public/data/point-facilities.json · point-walk.bin (scripts/build-point-data.mjs가 만든다)
// 주거비는 거래가 동 단위로만 집계되어 있어 점 단위로 다시 계산하지 않는다.
import { loadRelease } from '../lib/data-release.ts'
import { scoreMetric } from '../lib/score-normalization.ts'
import type { ScoreCalibration } from '../lib/score-normalization.ts'
import type { Area } from '../lib/types.ts'
import { walkMinutes } from './plain.ts'

type Kind = 'bus' | 'safety' | 'cctv' | 'bell' | 'hospitals' | 'pharmacies' | 'emergency' | 'night'
interface Grid { stepM: number; lat0: number; lon0: number; dLat: number; dLon: number; rows: number; cols: number }
interface Facilities {
  version: number; snapshotId: string
  normalization: Record<'safety' | 'transit' | 'medical', ScoreCalibration>
  walkGrid: Grid & { file: string }
  stations: string[]; stationPoints: number[]; stationLines: string[]
  points: Record<Kind, number[]>; cctvSource?: 'public' | 'safe-return'
}
export interface PointData { grid: Grid; stations: string[]; stationPlaces: { name: string; lines: string; latitude: number; longitude: number }[]; norm: Facilities['normalization']; pts: Record<Kind, Float64Array>; meters: Uint16Array; seconds: Uint16Array; station: Uint16Array; snapshotId: string; publicCctv?: boolean }

let cache: Promise<PointData> | null = null
let cacheId: string | undefined
/** 처음 위치를 찍을 때 한 번만 받는다(약 1MB, 압축 전송 기준). */
export function loadPointData(snapshotId?: string): Promise<PointData> {
  if (cacheId !== snapshotId) { cache = null; cacheId = snapshotId }
  cache ??= (async () => {
    const release = await loadRelease()
    if (snapshotId && release && release.id !== snapshotId) throw new Error('자료가 갱신됐어요. 화면을 새로고침해 주세요.')
    const res = await fetch(release?.points ?? '/data/point-facilities.json')
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error('위치 점검 자료(point-facilities.json)를 찾지 못했어요.')
    const f = await res.json() as Facilities
    if (snapshotId && f.snapshotId !== snapshotId) throw new Error('위치 점검과 추천 자료 버전이 달라요. 화면을 새로고침해 주세요.')
    const bin = await fetch(release?.walk ?? `/data/${f.walkGrid.file}`)
    if (!bin.ok) throw new Error('보행 거리 자료(point-walk.bin)를 찾지 못했어요.')
    const buf = await bin.arrayBuffer(), n = f.walkGrid.rows * f.walkGrid.cols
    if (buf.byteLength !== n * 6) throw new Error('보행 거리 자료의 크기가 맞지 않아요. 자료를 다시 만들어 주세요.')
    const pts = Object.fromEntries(Object.entries(f.points).map(([k, v]) => [k, Float64Array.from(v, x => x / 1e5)])) as Record<Kind, Float64Array>
    pts.bell ??= new Float64Array()
    const stationPlaces = f.stations.map((name, i) => ({ name, lines: f.stationLines?.[i] ?? '', latitude: f.stationPoints[i * 2] / 1e5, longitude: f.stationPoints[i * 2 + 1] / 1e5 }))
    return { grid: f.walkGrid, stations: f.stations, stationPlaces, norm: f.normalization, pts, meters: new Uint16Array(buf, 0, n), seconds: new Uint16Array(buf, n * 2, n), station: new Uint16Array(buf, n * 4, n), snapshotId: f.snapshotId, publicCctv: f.cctvSource === 'public' }
  })()
  cache.catch(() => { cache = null })
  return cache
}

const R = Math.PI / 180
function meters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dy = (lat2 - lat1) * R, dx = (lon2 - lon1) * R
  const h = Math.sin(dy / 2) ** 2 + Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.sin(dx / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}
function scan(list: Float64Array, lat: number, lon: number, radius: number) {
  let nearest = Infinity, count = 0
  for (let i = 0; i < list.length; i += 2) {
    // 위도 차이만으로 멀리 있는 점은 거리 계산을 건너뛴다
    const dy = Math.abs(list[i] - lat) * 111195
    if (dy > nearest && dy > radius) continue
    const d = meters(lat, lon, list[i], list[i + 1])
    if (d < nearest) nearest = d
    if (d <= radius) count++
  }
  return { nearest, count }
}

export interface PointMetrics {
  walk: { meters: number; minutes: number; station: string | null } | null
  busM: number; safetyNearestM: number; safety500: number; cctv500: number
  hospitalM: number; pharmacyM: number; emergencyM: number; hospitals500: number; pharmacies500: number; night1000: number
  scores: { safety: number; transit: number | null; medical: number }
}

/** 한 점의 지표: 동 대표점과 같은 식·같은 정규화 기준(서울 전체 동의 백분위) */
export function measurePoint(d: PointData, lat: number, lon: number, area?: Area | null): PointMetrics {
  const representative = area?.latitude === lat && area.longitude === lon ? area : null
  const g = d.grid
  const row = Math.floor((lat - g.lat0) / g.dLat), col = Math.floor((lon - g.lon0) / g.dLon)
  const i = row >= 0 && row < g.rows && col >= 0 && col < g.cols ? row * g.cols + col : -1
  const m = i >= 0 ? d.meters[i] : 0xffff
  const gridWalk = m === 0xffff ? null : { meters: m, minutes: Math.max(1, Math.round(d.seconds[i] / 60)), station: d.station[i] === 0xffff ? null : d.stations[d.station[i]] ?? null }
  let walk = gridWalk
  if (representative) {
    const minutes = walkMinutes(representative)
    const distance = representative.walking?.distanceM
    walk = minutes != null && distance != null ? { meters: distance, minutes, station: null } : null
  }
  const bus = scan(d.pts.bus, lat, lon, 0).nearest
  const safety = scan(d.pts.safety, lat, lon, 500), cctv = scan(d.pts.cctv, lat, lon, 500)
  const nearestSafety = Math.min(safety.nearest, cctv.nearest, scan(d.pts.bell, lat, lon, 500).nearest)
  const hosp = scan(d.pts.hospitals, lat, lon, 500), pharm = scan(d.pts.pharmacies, lat, lon, 500)
  const emerg = scan(d.pts.emergency, lat, lon, 0).nearest, night = scan(d.pts.night, lat, lon, 1000).count
  const e = (x: number, s: number) => Math.exp(-x / s)
  const raw = {
    safety: .5 * Math.min(cctv.count / 5, 1) + .5 * e(nearestSafety, 500),
    transit: walk ? .6 * e(walk.meters, 500) + .4 * e(bus, 300) : null,
    medical: .5 * e(hosp.nearest, 500) + .3 * e(pharm.nearest, 500) + .2 * e(emerg, 3000),
  }
  const score = (k: 'safety' | 'transit' | 'medical', v: number) => Math.round(scoreMetric(v, d.norm[k]))
  return {
    walk, busM: bus, safetyNearestM: nearestSafety, safety500: safety.count, cctv500: cctv.count,
    hospitalM: hosp.nearest, pharmacyM: pharm.nearest, emergencyM: emerg, hospitals500: hosp.count, pharmacies500: pharm.count, night1000: night,
    scores: {
      safety: score('safety', raw.safety),
      transit: representative ? representative.scores.transit : raw.transit == null ? null : score('transit', raw.transit),
      medical: score('medical', raw.medical),
    },
  }
}

/** 점이 들어 있는 법정동 */
export function areaAt(areas: Area[], lat: number, lon: number): Area | null {
  const representative = areas.find(a => a.latitude === lat && a.longitude === lon)
  if (representative) return representative
  const ring = (r: number[][]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c } return c }
  for (const a of areas) {
    const b = a.boundary
    if (!b) continue
    const polys = b.type === 'Polygon' ? [b.coordinates] : b.coordinates
    if (polys.some(p => ring(p[0] as number[][]) && !p.slice(1).some(h => ring(h as number[][])))) return a
  }
  return null
}

export const distanceFrom = (a: { latitude: number; longitude: number }, lat: number, lon: number) => meters(a.latitude, a.longitude, lat, lon)
