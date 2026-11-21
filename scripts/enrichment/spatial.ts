import proj4 from 'proj4'
import { isInSeoul } from '../../src/lib/seoul.ts'

proj4.defs('EPSG:5174', '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-146.43,507.89,681.46 +units=m +no_defs')
export const text = (value: unknown) => String(value ?? '').trim()
export const num = (value: unknown) => text(value) ? Number(text(value).replaceAll(',', '')) : NaN
export function field(row: Record<string, unknown>, ...keys: string[]) {
  const lookup = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]))
  return keys.map(k => lookup.get(k.toLowerCase())).find(v => v !== undefined && v !== null && text(v) !== '')
}
export interface FacilityPoint { id: string; latitude: number; longitude: number; kind: string; sourceDate: string; count?: number }
export function normalizeFacilities(rows: Record<string, unknown>[], kind: 'cctv' | 'bell' | 'stores') {
  const points: FacilityPoint[] = [], seen = new Set<string>()
  const qa = { rows: rows.length, accepted: 0, invalid: 0, outsideSeoul: 0, duplicates: 0, projected: 0 }
  for (const row of rows) {
    let latitude = num(field(row, 'LAT', 'latitude', '위도')), longitude = num(field(row, 'LOT', 'lon', 'longitude', '경도'))
    if (kind === 'bell' && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
      const x = num(field(row, 'X', 'X_CRD', 'X_CRDNT')), y = num(field(row, 'Y', 'Y_CRD', 'Y_CRDNT'))
      if (Number.isFinite(x) && Number.isFinite(y)) { [longitude, latitude] = proj4('EPSG:5174', 'EPSG:4326', [x, y]); qa.projected++ }
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) { qa.invalid++; continue }
    if (!isInSeoul(latitude, longitude)) { qa.outsideSeoul++; continue }
    const purpose = text(field(row, 'INSTL_PRPS', 'INSTL_PRPS_NM', '설치목적'))
    const category = kind === 'stores' ? text(field(row, 'indsSclsNm', '상권업종소분류명')) : kind
    // Camera purpose is explicit. Unknown/traffic-only purposes cannot become crime-prevention cameras.
    if (kind === 'cctv' && !/방범|범죄|생활안전|다목적/.test(purpose)) continue
    const manager = text(field(row, 'MNG_INST_NM', 'MNG_INST', '관리기관명'))
    const id = text(field(row, 'bizesId', 'MNG_NO', 'FCLT_MNG_NO', 'SN', 'SEQ_NO', '관리번호')) || `${manager}:${latitude}:${longitude}:${purpose}`
    if (seen.has(id)) { qa.duplicates++; continue }; seen.add(id)
    const count = num(field(row, 'CCTV_KD_CNT', 'CAM_CNT', 'CCTV_CNT', '카메라대수'))
    points.push({ id: `${kind}:${id}`, latitude, longitude, kind: category, sourceDate: text(field(row, 'DAT_CRTR_YMD', 'stdrYm', '데이터기준일자')), ...(Number.isSafeInteger(count) && count > 0 ? { count } : {}) })
  }
  qa.accepted = points.length
  return { points, qa }
}
export function distance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = Math.PI / 180, dy = (b.latitude - a.latitude) * r, dx = (b.longitude - a.longitude) * r
  const h = Math.sin(dy / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dx / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}
export function contains(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon, latitude: number, longitude: number) {
  const ring = (r: number[][]) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > latitude) !== (b[1] > latitude) && longitude < (b[0] - a[0]) * (latitude - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside }; return inside }
  return (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).some(p => ring(p[0]) && !p.slice(1).some(ring))
}
