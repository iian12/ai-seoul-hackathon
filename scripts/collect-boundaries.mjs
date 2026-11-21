import { mkdir, writeFile, rename } from 'node:fs/promises'
import { requestJson, SourceError } from './enrichment/api.mjs'
const root = 'data/enrichment'
await mkdir(root, { recursive: true })
const status = { id: 'boundary', name: '공식 법정동 경계', status: 'missing_key', checkedAt: new Date().toISOString() }
try {
  const key = process.env.VWORLD_API_KEY
  if (!key) throw new SourceError('missing_key', 'VWORLD_API_KEY 설정 필요')
  const features = [], codes = new Set()
  let expected
  for (let page = 1; page < 100; page++) {
    const u = new URL('https://api.vworld.kr/req/data')
    u.search = new URLSearchParams({ key, domain: process.env.VWORLD_DOMAIN || 'http://localhost:5173', service: 'data', version: '2.0', request: 'GetFeature', data: 'LT_C_ADEMD_INFO', attrfilter: 'emd_cd:like:11', crs: 'EPSG:4326', size: '1000', page: String(page), geometry: 'true', attribute: 'true', format: 'json' })
    const j = (await requestJson(u, [key])).response
    if (j?.status !== 'OK') throw new SourceError('failed', 'vworld_response_error')
    const total = Number(j.record?.total)
    expected ??= total
    const rows = j.result?.featureCollection?.features
    if (!Number.isSafeInteger(total) || total !== expected || !Array.isArray(rows) || !rows.length) throw new SourceError('failed', 'boundary_total_changed')
    for (const f of rows) {
      const code = String(f.properties?.emd_cd || ''), name = f.properties?.emd_kor_nm
      if (!/^11\d{6}$/.test(code) || !name || codes.has(code) || !['Polygon', 'MultiPolygon'].includes(f.geometry?.type)) throw new SourceError('failed', 'invalid_legal_boundary')
      codes.add(code); features.push({ type: 'Feature', properties: { EMD_CD: code, EMD_KOR_NM: name }, geometry: f.geometry })
    }
    if (features.length === expected) break
  }
  if (features.length !== expected || new Set(features.map(f => f.properties.EMD_CD.slice(0, 5))).size !== 25) throw new SourceError('failed', 'seoul_boundary_coverage')
  const observedDate = process.env.VWORLD_BOUNDARY_DATE
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate || '') || !Number.isFinite(Date.parse(observedDate))) throw new SourceError('not_configured', '도형 실제 기준일 확인 후 VWORLD_BOUNDARY_DATE 설정 필요')
  await writeFile(`${root}/boundaries.tmp`, JSON.stringify({ type: 'FeatureCollection', verified: true, observedDate, retrievedAt: status.checkedAt, features }))
  await rename(`${root}/boundaries.tmp`, `${root}/boundaries.json`)
  status.status = 'complete'; status.rows = features.length
} catch (e) { status.status = e instanceof SourceError ? e.status : 'failed'; status.message = e instanceof SourceError ? e.message : 'boundary_collection_failed' }
await writeFile(`${root}/boundary-status.json`, JSON.stringify(status, null, 2))
console.log(`${status.id}: ${status.status}`)
