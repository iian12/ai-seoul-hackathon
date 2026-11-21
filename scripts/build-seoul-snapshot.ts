import { publishSnapshot } from './publish-snapshot.mjs'
import { readFile, readdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { isInSeoul, seoulDistricts } from '../src/lib/seoul.ts'
import { validateSnapshot, normalizeMetric } from '../src/lib/recommend.ts'
import type { Area, Snapshot, Source } from '../src/lib/types.ts'
import { attachWalking } from '../src/lib/walking-snapshot.ts'
import { rentalWindowStart, RENTAL_WINDOW_MONTHS } from '../src/lib/rental-window.ts'
import { applyPercentileScores } from '../src/lib/score-normalization.ts'
import { applyEnrichment } from './enrichment/apply.ts'
import { contains } from './enrichment/spatial.ts'
import { applyPolicingScores } from '../src/lib/crime.ts'

const root = 'data/full-seoul'
const report = JSON.parse(await readFile(`${root}/report.json`, 'utf8'))
const required = ['tbLnOpendataRentV', 'subwayStationMaster', 'busStopLocationXyInfo', 'tbSafeReturnItem', 'tbSafeReturnRouteLink', 'tbSafeReturnService', 'hira-hospital', 'hira-pharmacy', 'nmc-pharmacy', 'nmc-hospital', 'nmc-emergency']
if (required.some(id => report.sources[id]?.status !== 'complete')) throw new Error('필수 원천 전량 수집 미완료. 기존 정상 스냅샷을 유지합니다.')
async function* pages(id: string) {
  for (const f of (await readdir(`${root}/${id}`)).filter(f => f.endsWith('.json.gz')).sort()) {
    const data = JSON.parse(gunzipSync(await readFile(`${root}/${id}/${f}`)).toString())
    yield data.rows as Record<string, unknown>[]
  }
}
async function rows(id: string) { const out: Record<string, unknown>[] = []; for await (const p of pages(id)) out.push(...p); return out }
const str = (v: unknown) => String(v ?? '').trim()
const numeric = (v: unknown) => { const s = str(v).replaceAll(',', ''); return s ? Number(s) : NaN }
type Point = { latitude: number; longitude: number; id: string; code?: string; kind?: string; date?: string; count?: number }
const qa: Record<string, unknown> = { createdAt: new Date().toISOString(), sources: report.sources, facilities: {}, mapping: {}, exclusions: {}, model: 'seoul-observed-1.0' }
try { qa.auxiliarySources = JSON.parse(await readFile(`${root}/aux-report.json`, 'utf8')) } catch { /* main station source remains mandatory */ }
qa.safetyCodebook = { source: '서울시 OA-21696 공식 안전시설물 코드유형 XLSX', coordinateSystem: 'EPSG:4326 WGS84', codes: { '301': '안심벨', '302': 'CCTV', '303': '안내표지판', '304': '노면표기', '305': '보안등', '306': '서비스 안내판', '307': '112 위치신고', '308': '기타' } }
function points(id: string, records: Record<string, unknown>[], convert: (r: Record<string, unknown>) => Point) {
  const seen = new Set<string>(), valid: Point[] = []; let outside = 0, duplicate = 0, invalid = 0
  for (const r of records) {
    const p = convert(r)
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) { invalid++; continue }
    if (!isInSeoul(p.latitude, p.longitude)) { outside++; continue }
    if (seen.has(p.id)) { duplicate++; continue }; seen.add(p.id); valid.push(p)
  }
  ;(qa.facilities as Record<string, unknown>)[id] = { sourceRows: records.length, accepted: valid.length, outsideSeoul: outside, invalidCoordinates: invalid, duplicateIds: duplicate }
  return valid
}
const stations = points('subway', await rows('subwayStationMaster'), r => ({ latitude: numeric(r.LAT), longitude: numeric(r.LOT), id: str(r.BLDN_ID) }))
const buses = points('bus', (await rows('busStopLocationXyInfo')).filter(r => !/선착장/.test(str(r.STOPS_TYPE))), r => ({ latitude: numeric(r.YCRD), longitude: numeric(r.XCRD), id: str(r.STOPS_NO) }))
const safetyRaw = await rows('tbSafeReturnItem')
const safety = points('safety', safetyRaw, r => {
  const v = str(r.POINT_WKT).match(/POINT\s*\(\s*([\d.-]+)\s+([\d.-]+)\s*\)/)
  return { latitude: Number(v?.[2]), longitude: Number(v?.[1]), id: str(r.FACI_ID), code: str(r.EMD_CODE), kind: str(r.FACI_CODE), date: str(r.REFDATE), count: numeric(r.INSTL_CNT) || 1 }
})
const hospitals = points('hospital', (await rows('hira-hospital')).filter(r => !/치과|한방|한의원|요양|정신/.test(str(r.clCdNm))), r => ({ latitude: numeric(r.YPos), longitude: numeric(r.XPos), id: str(r.ykiho) }))
const pharmacies = points('pharmacy', await rows('hira-pharmacy'), r => ({ latitude: numeric(r.YPos), longitude: numeric(r.XPos), id: str(r.ykiho) }))
const emergency = points('emergency', (await rows('nmc-emergency')).filter(r => str(r.dutyEmcls) !== 'G099'), r => ({ latitude: numeric(r.wgs84Lat), longitude: numeric(r.wgs84Lon), id: str(r.hpid) }))
const nightPharmacies = points('night-pharmacy', (await rows('nmc-pharmacy')).filter(r => Array.from({ length: 8 }, (_, i) => str(r[`dutyTime${i + 1}c`])).some(s => /^\d{4}$/.test(s) && (Number(s) >= 2200 || Number(s) <= 600))), r => ({ latitude: numeric(r.wgs84Lat), longitude: numeric(r.wgs84Lon), id: str(r.hpid) }))
if ([stations, buses, safety, hospitals, pharmacies, emergency].some(a => !a.length)) throw new Error('필수 시설 좌표가 없습니다. 기존 정상본을 유지합니다.')

function distance(a: { latitude: number; longitude: number }, b: Point) {
  const rad = Math.PI / 180, dy = (a.latitude - b.latitude) * rad, dx = (a.longitude - b.longitude) * rad
  const h = Math.sin(dy / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dx / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}
const nearest = (a: Area, pts: Point[]) => pts.reduce((min, p) => Math.min(min, distance(a, p)), Infinity)
// Count observed facility IDs, not an assumed number of installed cameras.
const within = (a: Area, pts: Point[], radius: number) => pts.reduce((n, p) => n + (distance(a, p) <= radius ? 1 : 0), 0)
type BoundaryGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon
type BoundaryProperties = { EMD_CD: string; EMD_KOR_NM: string; latitude: number; longitude: number }
const boundary = JSON.parse(await readFile('src/data/seoul-legal-boundaries.json', 'utf8')) as
  GeoJSON.FeatureCollection<BoundaryGeometry, BoundaryProperties> & { source: Source }
const districts = new Map(seoulDistricts.features.map(f => [str(f.properties?.SIG_CD), f]))
const areas: Area[] = [], byCode = new Map<string, Area>()
for (const f of boundary.features) {
  const { EMD_CD, EMD_KOR_NM: name, latitude, longitude } = f.properties
  const district = districts.get(EMD_CD.slice(0, 5))
  const code = EMD_CD + '00'
  if (!district || !/^11\d{6}$/.test(EMD_CD) || !name || byCode.has(code)
    || !contains(f.geometry, latitude, longitude) || !contains(district.geometry, latitude, longitude)) {
    throw new Error(`법정동 경계·대표점 검증 실패: ${code}`)
  }
  const a: Area = { code, name, district: str(district.properties?.SIG_KOR_NM), latitude, longitude, boundary: f.geometry, transactions: [], rentalGroups: [], jeonseGroups: [], scores: { safety: null, transit: null, medical: null }, evidence: [], flags: ['법정동 경계 내부 대표점 기준 · 실제 집 위치와 다를 수 있습니다.'] }
  areas.push(a); byCode.set(code, a)
}

// Build a fresh SQLite file. Raw cached pages stay untouched; only a complete build is published.
const db = new DatabaseSync(`${root}/rentals-build.sqlite`)
db.exec('drop table if exists rental; create table rental(area text not null, deposit integer not null, rent integer not null, date text not null); pragma journal_mode=WAL;')
db.exec('drop table if exists jeonse; create table jeonse(area text not null, deposit integer not null, date text not null);')
db.exec('drop table if exists lease_detail; create table lease_detail(area text not null,deposit integer not null,rent integer not null,size real not null,date text not null,type text not null,floor integer,year integer,kind text not null);')
const insertDetail = db.prepare('insert into lease_detail values(?,?,?,?,?,?,?,?,?)')
const insert = db.prepare('insert into rental values(?,?,?,?)')
const insertJeonse = db.prepare('insert into jeonse values(?,?,?)')
const rejected: Record<string, number> = {}, unmapped: Record<string, { name: string; count: number }> = {}
let total = 0, accepted = 0, acceptedJeonse = 0, minDate = '9999-99-99', maxDate = '0000-00-00', pageCount = 0
const reject = (reason: string) => { rejected[reason] = (rejected[reason] || 0) + 1 }
for await (const page of pages('tbLnOpendataRentV')) {
  db.exec('begin')
  for (const r of page) {
    total++
    const code = str(r.CGG_CD) + str(r.STDG_CD), a = byCode.get(code)
    if (!a || a.name !== str(r.STDG_NM) || a.district !== str(r.CGG_NM)) { reject('unmapped_or_changed_legal_code'); const key = `${code}:${str(r.CGG_NM)} ${str(r.STDG_NM)}`; unmapped[key] ??= { name: `${str(r.CGG_NM)} ${str(r.STDG_NM)}`, count: 0 }; unmapped[key].count++; continue }
    const deposit = numeric(r.GRFE) * 10000, rent = numeric(r.RTFE) * 10000, size = numeric(r.RENT_AREA), rawDate = str(r.CTRT_DAY)
    const lease = str(r.RENT_SE)
    if (!['월세', '전세'].includes(lease)) { reject('unknown_lease_type'); continue }
    if (lease === '월세' && rent <= 0) { reject('not_monthly'); continue }
    if (lease === '전세' && (deposit <= 0 || rent !== 0)) { reject('invalid_jeonse_amounts'); continue }
    if (!Number.isSafeInteger(deposit) || deposit < 0 || !Number.isSafeInteger(rent) || !Number.isFinite(size) || size <= 0 || !str(r.BLDG_USG) || !/^\d{8}$/.test(rawDate)) { reject('invalid_transaction'); continue }
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > new Date().toISOString().slice(0, 10)) { reject('invalid_or_future_contract_date'); continue }
    if (date < minDate) minDate = date; if (date > maxDate) maxDate = date
    if (lease === '전세') { insertJeonse.run(code, deposit, date); acceptedJeonse++ }
    else { insert.run(code, deposit, rent, date); accepted++ }
    const rawFloor = numeric(r.FLR), rawYear = numeric(r.ARCH_YR)
    insertDetail.run(code, deposit, rent, size, date, str(r.BLDG_USG), Number.isInteger(rawFloor) ? rawFloor : null,
      Number.isInteger(rawYear) && rawYear >= 1800 && rawYear <= Number(date.slice(0, 4)) ? rawYear : null, str(r.NEW_UPDT_YN))
  }
  db.exec('commit')
  if (++pageCount % 300 === 0) console.log(`집계 ${pageCount} pages / ${total} source rows`)
}
if (total !== report.sources.tbLnOpendataRentV.expected) throw new Error('원천 총 건수와 적재 건수 불일치')
const allValidMonthlyRows = accepted, allValidJeonseRows = acceptedJeonse, allPeriodStart = minDate
const cutoff = rentalWindowStart(maxDate)
minDate = minDate < cutoff ? cutoff : minDate
accepted = Number(db.prepare('select count(*) as n from rental where date>=? and date<=?').get(minDate, maxDate)!.n)
acceptedJeonse = Number(db.prepare('select count(*) as n from jeonse where date>=? and date<=?').get(minDate, maxDate)!.n)
db.exec('create index rental_area on rental(area);')
for (const row of db.prepare('select area,deposit,rent,count(*) as n from rental where date>=? and date<=? group by area,deposit,rent').iterate(minDate, maxDate)) {
  byCode.get(String(row.area))!.rentalGroups!.push({ depositKrw: Number(row.deposit), monthlyRentKrw: Number(row.rent), count: Number(row.n) })
}
db.exec('create index jeonse_area on jeonse(area);')
for (const row of db.prepare('select area,deposit,count(*) as n from jeonse where date>=? and date<=? group by area,deposit').iterate(minDate, maxDate)) {
  byCode.get(String(row.area))!.jeonseGroups!.push({ depositKrw: Number(row.deposit), count: Number(row.n) })
}
db.exec('create index lease_detail_area on lease_detail(area,date);')
const detailCount = Number(db.prepare('select count(*) as n from lease_detail').get()!.n)
if (detailCount !== allValidMonthlyRows + allValidJeonseRows) throw new Error('상세 원자료 보존 건수 불일치')
qa.detailCount = detailCount
qa.rentalWindow = { months: RENTAL_WINDOW_MONTHS, start: minDate, end: maxDate, allPeriodStart, allValidMonthlyRows, allValidJeonseRows, excludedOlderMonthlyRows: allValidMonthlyRows - accepted, excludedOlderJeonseRows: allValidJeonseRows - acceptedJeonse, housingTypes: 'all', sizes: 'all', detailStorage: 'private SQLite lease_detail, not sent to browser' }
db.close()
const groupedJeonseCount = areas.reduce((sum, a) => sum + a.jeonseGroups!.reduce((n, g) => n + g.count, 0), 0)
if (groupedJeonseCount !== acceptedJeonse) throw new Error('전세 보증금 분포 집계 건수 불일치')
qa.groupedJeonseCount = groupedJeonseCount
const groupedCount = areas.reduce((sum, a) => sum + a.rentalGroups!.reduce((n, g) => n + g.count, 0), 0)
if (groupedCount !== accepted) throw new Error('보증금·월세 공동 분포 집계 건수 불일치')
if (new Set(areas.map(a => a.district)).size !== 25) throw new Error('서울 25개 자치구 매핑 누락')
qa.groupedCount = groupedCount
qa.mapping = { boundaryVersion: boundary.source.observedDate, spatialUnit: '법정동', method: 'CGG_CD + STDG_CD exact code and name match; no inferred administrative mapping', areas: areas.length, sourceRows: total, acceptedMonthlyRows: accepted, acceptedJeonseRows: acceptedJeonse, unmapped }
qa.exclusions = rejected

const rawScores: { area: Area; safety: number; transit: number; medical: number }[] = []
for (const a of areas) {
  const station = nearest(a, stations), bus = nearest(a, buses), safe = nearest(a, safety), hosp = nearest(a, hospitals), pharm = nearest(a, pharmacies), emerg = nearest(a, emergency)
  // Official OA-21696 codebook: 301 alarm bell, 302 CCTV, 305 security light.
  const cctv = within(a, safety.filter(p => p.kind === '302'), 500)
  const safeCount = within(a, safety, 500), hospitalCount = within(a, hospitals, 500), pharmacyCount = within(a, pharmacies, 500), nightCount = within(a, nightPharmacies, 1000)
  const access = (m: number, scale: number) => Math.exp(-m / scale)
  a.metrics = { stationDistanceM: station, busDistanceM: bus, observedSafetyDistanceM: safe, observedCctv500m: cctv, observedSafety500m: safeCount, hospitalDistanceM: hosp, pharmacyDistanceM: pharm, emergencyDistanceM: emerg, hospitals500m: hospitalCount, pharmacies500m: pharmacyCount, nightPharmacies1000m: nightCount }
  rawScores.push({ area: a, safety: .5 * Math.min(cctv / 5, 1) + .5 * access(safe, 500), transit: .6 * access(station, 500) + .4 * access(bus, 300), medical: .5 * access(hosp, 500) + .3 * access(pharm, 500) + .2 * access(emerg, 3000) })
  a.evidence = [
    { label: '관측 안전시설', value: `대표점 500m 내 ${safeCount}지점 · 그중 CCTV ${cctv}지점 (안심귀갓길 목록 한정)`, sourceId: 'safety' },
    { label: '대중교통 접근성', value: `가장 가까운 역 ${Math.round(station)}m · 정류소 ${Math.round(bus)}m (직선거리)`, sourceId: 'transit' },
    { label: '의료 접근성', value: `500m 내 일반 병·의원 ${hospitalCount}곳 · 약국 ${pharmacyCount}곳 · 응급기관 ${Math.round(emerg)}m`, sourceId: 'medical' },
    { label: '야간 약국 참고', value: `1km 내 주간 공시 종료시간 22시 이후 표본 ${nightCount}곳 · 현재 영업 아님`, sourceId: 'night' },
    { label: '지역 매핑', value: `${a.code} · 법정동 코드·이름 일치 · 경계 내부 대표점`, sourceId: 'boundary' },
  ]
  a.flags.push('안전시설은 안심귀갓길 자료에 관측된 시설만 포함하며 서울 전체 CCTV 분포나 범죄 위험을 뜻하지 않습니다.')
}
const quantile = (v: number[], q: number) => { const sorted = [...v].sort((a, b) => a - b), i = (sorted.length - 1) * q; return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1) }
const normalization: Record<string, unknown> = {}
for (const k of ['safety', 'transit', 'medical'] as const) {
  const values = rawScores.map(r => r[k]), p5 = quantile(values, .05), p95 = quantile(values, .95)
  normalization[k] = { p5, p95 }
  for (const r of rawScores) r.area.scores[k] = normalizeMetric(r[k], p5, p95).score
  for (const r of rawScores) r.area.metrics![`${k}Raw`] = r[k]
}
qa.normalization = normalization
const now = new Date().toISOString(), today = now.slice(0, 10)
const dates = [...new Set(safety.map(p => p.date).filter(Boolean))].sort()
const safetyDate = dates[dates.length - 1]!
let snapshot: Snapshot = {
  id: `seoul-observed-${today}-leases`, modelVersion: 'seoul-observed-1.0', isDemo: false, spatialUnit: '법정동 · 공식 경계와 원천 코드·이름 일치 지역', createdAt: now, periodStart: minDate, periodEnd: maxDate, areas,
  calculation: { normalization, safety: '0.5*min(observedCCTV500m/5,1)+0.5*exp(-nearestObservedSafetyM/500)', transit: '0.6*exp(-stationM/500)+0.4*exp(-busM/300)', medical: '0.5*exp(-hospitalM/500)+0.3*exp(-pharmacyM/500)+0.2*exp(-emergencyM/3000)', housing: '0.6*budgetMatchRatio*100+0.4*clamp(100*(maxRent-medianRent)/maxRent,0,100)', safetyCoverage: 'Only observed safe-return-route facilities, not citywide CCTV inventory', distance: 'WGS84 haversine from interior representative point of official legal-dong polygon', jeonseHousing: '60*jeonseBudgetMatchRatio+0.4*clamp(100*(maxDeposit-medianJeonseDeposit)/maxDeposit,0,100); jeonse-only samples, minimum 10 matching', rentalDistribution: 'Exact joint deposit/rent count bins after validation. No duplicate import from overlapping national rent APIs.' },
  warnings: ['실제 공공데이터를 사용한 잠정 비교 모델입니다. 안전 점수는 범죄 확률이 아닌 관측 안전시설 접근성입니다.', '안심귀갓길 시설의 현장 기준일은 2022년으로 오래됐습니다. 시설이 없다는 뜻으로 해석하지 마세요.', '법정동 대표점 직선거리 기준이며 실제 집 위치·도보 시간·현재 매물을 뜻하지 않습니다.', '법정동 코드 또는 이름이 변경된 거래는 추정 배분하지 않고 제외했습니다.'],
  sources: [
    { id: 'rent', name: '서울시 부동산 전월세가 · 공개 API 전체 페이지', provider: '서울특별시·국토교통부', url: 'https://data.seoul.go.kr/dataList/OA-21276/S/1/datasetView.do', license: '공공누리 1유형 · 원천 갱신일 별도 미제공', observedDate: '원천 갱신일 미제공', retrievedAt: now },
    { id: 'transit', name: '서울시 역사마스터·버스정류소 전체 목록', provider: '서울특별시', url: 'https://data.seoul.go.kr/dataList/OA-21232/A/1/datasetView.do', license: '출처표시 · 조회 시점 목록, 설치·갱신일 미제공', observedDate: '원천 갱신일 미제공', retrievedAt: now },
    { id: 'safety', name: '안심귀갓길 안전시설물 전체 목록', provider: '서울특별시', url: 'https://data.seoul.go.kr/dataList/OA-21696/S/1/datasetView.do', license: '공공누리 1유형 · 안심귀갓길 한정 관측', observedDate: `${safetyDate.slice(0, 4)}-${safetyDate.slice(4, 6)}-${safetyDate.slice(6)}`, retrievedAt: now },
    { id: 'medical', name: '심평원 병원·약국 및 국립중앙의료원 응급기관', provider: '건강보험심사평가원·국립중앙의료원', url: 'https://www.data.go.kr/data/15001698/openapi.do', license: '공공데이터 이용조건 · 조회 시점 목록, 원천 갱신일 미제공', observedDate: '원천 갱신일 미제공', retrievedAt: now },
    { id: 'night', name: '국립중앙의료원 약국 공시 운영시간', provider: '국립중앙의료원', url: 'https://www.data.go.kr/data/15000576/openapi.do', license: '공공데이터 이용조건 · 실시간 영업·심야 지정 여부 아님', observedDate: '원천 갱신일 미제공', retrievedAt: now },
    boundary.source,
  ],
}
let walkingCache: string | undefined
const cachedSourceIds: Record<string, string[]> = { rent: ['tbLnOpendataRentV'], transit: ['subwayStationMaster', 'busStopLocationXyInfo'], safety: ['tbSafeReturnItem'], medical: ['hira-hospital', 'hira-pharmacy', 'nmc-emergency'], night: ['nmc-pharmacy'] }
for (const source of snapshot.sources) {
  if (source.id === boundary.source.id) continue
  const dates = (cachedSourceIds[source.id] ?? []).map(id => report.sources[id]?.completedAt).filter(Boolean).sort()
  source.retrievedAt = dates[0] ?? report.startedAt ?? source.retrievedAt
}
try { walkingCache = await readFile('data/walking/routes.json', 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
if (walkingCache) {
  snapshot = attachWalking(snapshot, JSON.parse(walkingCache))
  qa.model = snapshot.modelVersion
  qa.normalization = { ...normalization, transit: snapshot.calculation!.transitNormalization }
  qa.walking = snapshot.calculation!.walking
}
snapshot.calculation = { ...snapshot.calculation, rentalWindow: qa.rentalWindow }
snapshot.warnings.push(`주거비는 자료의 마지막 계약일(${maxDate}) 기준 최근 ${RENTAL_WINDOW_MONTHS}개월 계약으로 집계합니다. 주택유형·면적은 전체를 포함합니다.`)
snapshot = await applyEnrichment(snapshot)
qa.mapping = { ...(qa.mapping as object), boundaryVersion: snapshot.sources.find(s => s.id === boundary.source.id)!.observedDate }
applyPercentileScores(snapshot)
applyPolicingScores(snapshot)
qa.normalization = snapshot.calculation!.normalization
qa.model = snapshot.modelVersion
validateSnapshot(snapshot)
await publishSnapshot(snapshot, { report: qa })
console.log(JSON.stringify({ areas: areas.length, acceptedMonthlyRows: accepted, acceptedJeonseRows: acceptedJeonse, sourceRows: total, rejected, periodStart: minDate, periodEnd: maxDate, output: 'public/data/seoul-snapshot.json' }, null, 2))
