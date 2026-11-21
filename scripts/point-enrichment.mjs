import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
export async function preparePointData(snapshot, pointPath = 'public/data/point-facilities.json', extraPath = 'data/enrichment/facilities.json', manifestPath = 'data/enrichment/manifest.json') {
const point = JSON.parse(await readFile(pointPath, 'utf8'))
const extra = JSON.parse(await readFile(extraPath, 'utf8'))
const facilityId = snapshot.calculation?.facilitySnapshotId ?? snapshot.id.replace(/-release-[a-f0-9-]{36}(?:-walking|-crime2025)*$/, '').replace(/(?:-walking|-crime2025)+$/, '')
if (extra.snapshotId !== facilityId) throw new Error('보완 시설과 추천 자료의 원천 버전 불일치')
snapshot.calculation.facilitySnapshotId = facilityId
const enc = rows => rows.flatMap(p => [Math.round(p.latitude * 1e5), Math.round(p.longitude * 1e5)])
if (extra.points.hospitals) point.points.hospitals = enc(extra.points.hospitals)
if (extra.points.pharmacies) point.points.pharmacies = enc(extra.points.pharmacies)
if (extra.points.cctv) point.points.cctv = enc(extra.points.cctv)
point.points.bell = extra.points.bell ? enc(extra.points.bell) : []
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const state = manifest.sources.find(s => s.id === 'pharmacy-hours' && s.status === 'complete')
if (state) {
  const rows = JSON.parse(gunzipSync(await readFile(`data/enrichment/${state.file}`)).toString())
  const seen = new Set()
  point.points.night = enc(rows.filter(r => {
    if (!r.hpid || seen.has(r.hpid) || !Number.isFinite(Number(r.wgs84Lat)) || !Number.isFinite(Number(r.wgs84Lon))) return false
    seen.add(r.hpid)
    return Array.from({ length: 7 }, (_, i) => [String(r[`dutyTime${i+1}s`] || ''), String(r[`dutyTime${i+1}c`] || '')]).some(([s,e]) => /^\d{4}$/.test(s) && /^\d{4}$/.test(e) && (Number(e) >= 2200 || Number(e) < Number(s)))
  }).map(r => ({ latitude: Number(r.wgs84Lat), longitude: Number(r.wgs84Lon) })))
}
point.snapshotId = snapshot.id
point.normalization.safety = snapshot.calculation.normalization.safety
point.normalization.medical = snapshot.calculation.normalization.medical
point.normalization.transit = snapshot.calculation.transitNormalization
point.cctvSource = extra.points.cctv ? 'public' : 'safe-return'
point.sources = snapshot.sources.map(s => `${s.name} · ${s.observedDate}`)
return point
}
