import { isInSeoul } from '../../src/lib/seoul.ts'
import { reconcileMedical } from './reconcile-medical.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import type { Snapshot, DataAvailability } from '../../src/lib/types.ts'
import { attachCrime } from '../../src/lib/crime.ts'
import { normalizeMetric } from '../../src/lib/recommend.ts'
import { normalizeFacilities, distance, contains, text } from './spatial.ts'
import type { FacilityPoint } from './spatial.ts'

interface State extends DataAvailability { file?: string; catalog?: string; license?: string; retrievedAt?: string }
async function medicalRecords(id: string): Promise<Record<string, unknown>[]> {
  const { readdir } = await import('node:fs/promises')
  const dir = `data/full-seoul/${id}`, records = []
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.json.gz')).sort()) records.push(...JSON.parse(gunzipSync(await readFile(`${dir}/${file}`)).toString()).rows)
  return records
}
export async function applyEnrichment(snapshot: Snapshot): Promise<Snapshot> {
  snapshot.sources = snapshot.sources.filter(s => !s.id.startsWith('extra-'))
  for (const a of snapshot.areas) a.evidence = a.evidence.filter(e => !e.sourceId.startsWith('extra-'))
  const crimeData = JSON.parse(await readFile('src/data/district-crime-2025.json', 'utf8'))
  snapshot = attachCrime(snapshot, crimeData, crimeData.retrievedAt)
  let states: State[] = []
  try { states = JSON.parse(await readFile('data/enrichment/manifest.json', 'utf8')).sources } catch { /* local rebuild may run without API keys */ }
  const points: Record<string, FacilityPoint[]> = {}, qa: Record<string, unknown> = {}
  for (const state of states.filter(s => ['cctv', 'bell', 'stores'].includes(s.id) && s.status === 'complete' && s.file)) {
    try {
      const raw = JSON.parse(gunzipSync(await readFile(`data/enrichment/${state.file}`)).toString())
      const normalized = normalizeFacilities(raw, state.id as 'cctv' | 'bell' | 'stores')
      if (!normalized.points.length) throw new Error('no_valid_points')
      points[state.id] = normalized.points; qa[state.id] = normalized.qa
      const dates = normalized.points.map(p => p.sourceDate).filter(Boolean).sort()
      snapshot.sources.push({ id: `extra-${state.id}`, name: state.name, provider: '공공데이터포털', url: state.catalog!, license: state.license!, observedDate: dates.length ? `${dates[0]} ~ ${dates.at(-1)}` : '원천 기준일 미제공', retrievedAt: state.retrievedAt! })
    } catch { state.status = 'failed'; state.message = '좌표·용도·원천 스키마 검증 실패'; delete points[state.id] }
  }
  // A new CCTV/bell list replaces only its own category. It is never added to the same old observations.
  const raws: { area: Snapshot['areas'][number]; value: number }[] = []
  for (const area of snapshot.areas) {
    area.metrics ??= {}
    for (const [id, list] of Object.entries(points)) {
      const distances = list.map(p => distance(area, p)), within = distances.filter(d => d <= 500).length
      area.metrics[`${id}500m`] = within
      area.metrics[`${id}NearestM`] = distances.reduce((m, d) => Math.min(m, d), Infinity)
      if (id === 'stores') {
        for (const [key, re] of [['convenience', /편의점/], ['grocery', /슈퍼|마트|식료품/], ['laundry', /세탁/]] as const) area.metrics[`${key}500m`] = list.filter((p, i) => re.test(p.kind) && distances[i] <= 500).length
      }
      area.evidence.push({ label: id === 'cctv' ? '공공 방범 CCTV' : id === 'bell' ? '안전비상벨' : '생활편의 업소', value: `대표점 직선 500m 내 ${within}지점 · ${snapshot.sources.find(s => s.id === `extra-${id}`)!.observedDate}`, sourceId: `extra-${id}` })
    }
    if (points.cctv || points.bell) {
      // Category counts never add the new CCTV inventory to the old CCTV observations.
      const cctv = points.cctv ? area.metrics.cctv500m : area.metrics.observedCctv500m
      const nearest = Math.min(area.metrics.observedSafetyDistanceM, area.metrics.cctvNearestM ?? Infinity, area.metrics.bellNearestM ?? Infinity)
      area.metrics.safetyAccessDistanceM = nearest
      const raw = .5 * Math.min(cctv / 5, 1) + .5 * Math.exp(-nearest / 500)
      area.metrics.safetyRaw = raw; raws.push({ area, value: raw })
    }
  }
  if (raws.length) {
    const values = raws.map(r => r.value).sort((a, b) => a - b)
    const q = (p: number) => { const i = (values.length - 1) * p; return values[Math.floor(i)] + (values[Math.ceil(i)] - values[Math.floor(i)]) * (i % 1) }
    const p5 = q(.05), p95 = q(.95)
    for (const r of raws) r.area.scores.safety = normalizeMetric(r.value, p5, p95).score
    const calculation = snapshot.calculation ??= {}
    ;(calculation.normalization as Record<string, unknown>).safety = { p5, p95 }
    calculation.safety = '0.5*min(availableCctv500m/5,1)+0.5*exp(-nearestAvailableSafetyM/500); new CCTV replaces legacy CCTV counts; unavailable sources remain explicitly labelled'
  }
  // Retain weekday schedules; closing time alone is not evidence of a currently-open pharmacy.
  async function hours(id: string, fallback: string) {
    const state = states.find(s => s.id === id && s.status === 'complete' && s.file)
    if (!state) return medicalRecords(fallback)
    const rows = JSON.parse(gunzipSync(await readFile(`data/enrichment/${state.file}`)).toString()) as Record<string, unknown>[]
    if (!rows.every(r => text(r.hpid) && Number.isFinite(Number(r.wgs84Lat)) && Number.isFinite(Number(r.wgs84Lon)))) throw new Error('의료 운영시간 좌표·기관 ID 확인 실패')
    snapshot.sources.push({ id: `extra-${id}`, name: state.name, provider: '국립중앙의료원', url: state.catalog!, license: state.license!, observedDate: '공시 운영시간 · 현장 영업 미확인', retrievedAt: state.retrievedAt! })
    return rows
  }
  const pharmacyRows = await hours('pharmacy-hours', 'nmc-pharmacy')
  const hospitalRows = await hours('hospital-hours', 'nmc-hospital')
  const hp = reconcileMedical((await medicalRecords('hira-hospital')).filter(r => !/치과|한방|한의원|요양|정신/.test(text(r.clCdNm))), hospitalRows)
  const pp = reconcileMedical(await medicalRecords('hira-pharmacy'), pharmacyRows)
  qa.medicalReconciliation = { hospital: hp.qa, pharmacy: pp.qa }
  const accepted = (p: {latitude:number;longitude:number}) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && isInSeoul(p.latitude, p.longitude)
  points.hospitals = hp.points.filter(accepted).map(p => ({ ...p, kind: 'hospital', sourceDate: '' }))
  points.pharmacies = pp.points.filter(accepted).map(p => ({ ...p, kind: 'pharmacy', sourceDate: '' }))
  for (const area of snapshot.areas) {
    const hd = points.hospitals.map(p => distance(area,p)), pd = points.pharmacies.map(p => distance(area,p))
    area.metrics!.hospitalDistanceM = hd.reduce((a,b) => Math.min(a,b),Infinity)
    area.metrics!.pharmacyDistanceM = pd.reduce((a,b) => Math.min(a,b),Infinity)
    area.metrics!.hospitals500m = hd.filter(d => d <= 500).length
    area.metrics!.pharmacies500m = pd.filter(d => d <= 500).length
    area.metrics!.medicalRaw = .5*Math.exp(-area.metrics!.hospitalDistanceM/500)+.3*Math.exp(-area.metrics!.pharmacyDistanceM/500)+.2*Math.exp(-area.metrics!.emergencyDistanceM/3000)
    const e=area.evidence.find(e=>e.label==='의료 접근성')
    if(e)e.value=`대표점 직선 500m 내 일반 병·의원 ${area.metrics!.hospitals500m}곳 · 약국 ${area.metrics!.pharmacies500m}곳. 심평원 기관 ID 기준, 의료원 기관명·전화번호·자치구 일치 및 100m 이내 좌표 대조.`
  }

  const pharmacies = pharmacyRows.map(r => ({ id: text(r.hpid), latitude: Number(r.wgs84Lat), longitude: Number(r.wgs84Lon), row: r }))
  const hospitals = hospitalRows.map(r => ({ id: text(r.hpid), latitude: Number(r.wgs84Lat), longitude: Number(r.wgs84Lon), row: r }))
  const scheduleNight = (r: Record<string, unknown>) => Array.from({ length: 7 }, (_, i) => {
    const start = text(r[`dutyTime${i + 1}s`]), end = text(r[`dutyTime${i + 1}c`])
    return /^\d{4}$/.test(start) && /^\d{4}$/.test(end) && (Number(end) >= 2200 || Number(end) < Number(start))
  }).some(Boolean)
  for (const area of snapshot.areas) {
    const nearbyPharmacies = new Map(pharmacies.filter(p => distance(area, p) <= 1000).map(p => [p.id, p.row]))
    const nearbyHospitals = new Map(hospitals.filter(p => distance(area, p) <= 1000).map(p => [p.id, p.row]))
    area.metrics!.nightPharmacies1000m = [...nearbyPharmacies.values()].filter(scheduleNight).length
    area.metrics!.sundayPharmacies1000m = [...nearbyPharmacies.values()].filter(r => text(r.dutyTime7s) && text(r.dutyTime7c)).length
    area.metrics!.weekendHospitals1000m = [...nearbyHospitals.values()].filter(r => (text(r.dutyTime6s) && text(r.dutyTime6c)) || (text(r.dutyTime7s) && text(r.dutyTime7c))).length
    area.evidence = area.evidence.filter(e => e.label !== '야간 약국 참고')
    area.evidence.push({ label: '공시 운영시간 참고', value: `1km 내 야간시간 표본 ${area.metrics!.nightPharmacies1000m}곳 · 일요일 약국 ${area.metrics!.sundayPharmacies1000m}곳. 현재 영업·공휴일 임시 변경은 미확인.`, sourceId: snapshot.sources.some(s => s.id === 'extra-pharmacy-hours') ? 'extra-pharmacy-hours' : 'night' })
    area.evidence.push({ label: '주말 의료기관 참고', value: `1km 내 주말 병·의원 ${area.metrics!.weekendHospitals1000m}곳 · 공시 시간 기준, 진료과목별 시간과 임시 휴진은 미확인.`, sourceId: snapshot.sources.some(s => s.id === 'extra-hospital-hours') ? 'extra-hospital-hours' : 'medical' })
  }
  const boundarySource = snapshot.sources.find(s => s.id === 'boundary')!
  try {
    const data = JSON.parse(await readFile('data/enrichment/boundaries.json', 'utf8'))
    if (data.verified !== true || !/^\d{4}-\d{2}-\d{2}$/.test(data.observedDate)
      || data.observedDate <= boundarySource.observedDate) throw new Error('boundary_not_newer')
    const byCode = new Map<string, GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>(data.features.map((f: GeoJSON.Feature) => [String(f.properties?.EMD_CD) + '00', f]))
    if (byCode.size !== snapshot.areas.length || byCode.size !== data.features.length
      || !snapshot.areas.every(a => byCode.get(a.code)?.properties?.EMD_KOR_NM === a.name)) throw new Error('boundary_code_name_mismatch')
    for (const area of snapshot.areas) {
      const shape = byCode.get(area.code)!.geometry
      if (!contains(shape, area.latitude, area.longitude)) throw new Error('representative_changed_rebuild_walks')
    }
    for (const area of snapshot.areas) area.boundary = byCode.get(area.code)!.geometry
    Object.assign(boundarySource, { name: '브이월드 공식 법정동 경계', provider: '국토교통부 / 브이월드', url: 'https://www.data.go.kr/data/15123903/openapi.do', license: '공공누리 1유형', observedDate: data.observedDate, retrievedAt: data.retrievedAt })
    snapshot.spatialUnit = '법정동 · 공식 경계와 원천 코드·이름 일치 지역'
    snapshot.warnings = snapshot.warnings.filter(w => !w.startsWith('법정동 경계는 2015'))
  } catch { /* Keep the bundled boundaries when an optional update cannot be applied. */ }
  if (boundarySource.provider === '국토교통부 / 브이월드') {
    states = states.filter(s => s.id !== 'boundary')
    states.push({ id: 'boundary', name: '공식 법정동 경계', checkedAt: boundarySource.retrievedAt, status: 'complete', rows: snapshot.areas.length })
  } else {
    const boundaryState = states.find(s => s.id === 'boundary')
    if (boundaryState?.status === 'complete') boundaryState.status = 'not_configured'
  }
  if (states.some(s => s.id === 'flood' && s.status === 'complete')) {
    const flood = states.find(s => s.id === 'flood')!
    flood.status = 'not_configured'; flood.message = '원본 수집 완료 · 제공처 이용조건 및 도형 좌표계 확인 후 공개 집계 가능'
  }
  snapshot.availability = states.map(({ id, name, status, checkedAt, rows }) => ({ id, name, status, checkedAt, ...(rows != null ? { rows } : {}) }))
  const waiting = states.filter(s => s.status !== 'complete').map(s => s.name)
  if (waiting.length) snapshot.warnings.push(`보완 자료 미반영: ${waiting.join('·')}. 활용승인·연결·검증이 완료된 원천만 반영하며 기존 자료의 한계를 유지합니다.`)
  snapshot.warnings.push('실거래 상세 필드는 비공개 원자료에 보존하며 결측값을 추정하지 않습니다. 새로 수집하지 못한 시설 자료는 0곳으로 간주하지 않습니다.')
  if (snapshot.areas.some(a => a.walking)) snapshot.modelVersion = 'seoul-enriched-2.0'
  snapshot.id = `${snapshot.id.replace(/-enriched$/, '')}-enriched`
  snapshot.calculation = { ...snapshot.calculation, enrichmentQa: qa, facilitySnapshotId: snapshot.id }
  await writeFile('data/enrichment/facilities.json', JSON.stringify({ snapshotId: snapshot.id, points }))
  return snapshot
}
