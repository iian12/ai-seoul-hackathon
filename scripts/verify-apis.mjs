import { mkdir, writeFile } from 'node:fs/promises'

// Never print request URLs, exceptions or raw bodies: they may echo credentials.
const env = process.env
const key = name => decodeURIComponent(env[name] || '')
const url = (base, params) => { const u = new URL(base); u.search = new URLSearchParams(params).toString(); return u }
const seoul = (service) => `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key('SEOUL_OPEN_DATA_API_KEY'))}/json/${service}/1/5/`
const publicApi = (path, params = {}) => url(`https://apis.data.go.kr/${path}`, { serviceKey: key('DATA_GO_KR_SERVICE_KEY'), numOfRows: '5', pageNo: '1', ...params })
const probes = [
  { id: 'seoul-rent', name: '서울시 전월세', env: 'SEOUL_OPEN_DATA_API_KEY', request: () => seoul('tbLnOpendataRentV') },
  { id: 'seoul-subway', name: '서울시 역사마스터', env: 'SEOUL_OPEN_DATA_API_KEY', request: () => seoul('subwayStationMaster') },
  { id: 'seoul-bus', name: '서울시 버스정류소', env: 'SEOUL_OPEN_DATA_API_KEY', request: () => seoul('busStopLocationXyInfo') },
  { id: 'hira-hospital', name: '심평원 병원정보', env: 'DATA_GO_KR_SERVICE_KEY', request: () => publicApi('B551182/hospInfoServicev2/getHospBasisList', { sidoCd: '110000' }) },
  { id: 'hira-pharmacy', name: '심평원 약국정보', env: 'DATA_GO_KR_SERVICE_KEY', request: () => publicApi('B551182/pharmacyInfoService/getParmacyBasisList', { sidoCd: '110000' }) },
  { id: 'nmc-pharmacy', name: '국립중앙의료원 약국', env: 'DATA_GO_KR_SERVICE_KEY', request: () => publicApi('B552657/ErmctInsttInfoInqireService/getParmacyListInfoInqire', { Q0: '서울특별시' }) },
  { id: 'tdata-subway', name: 'T-Data 지하철역 좌표', env: 'TDATA_API_KEY', request: () => url('https://t-data.seoul.go.kr/apig/apiman-gateway/tapi/TaimsKsccDvSubwayStationGeom/1.0', { apikey: key('TDATA_API_KEY'), startRow: '1', rowCnt: '5' }) },
  { id: 'safemap-wms', name: '생활안전지도 범죄주의구간 WMS', env: 'SAFEMAP_API_KEY', image: true, request: () => url('https://www.safemap.go.kr/openapi2/IF_0087_WMS', { serviceKey: key('SAFEMAP_API_KEY'), srs: 'EPSG:4326', bbox: '126.94,37.47,126.95,37.48', format: 'image/png', width: '256', height: '256', transparent: 'TRUE' }) },
]

const report = await Promise.all(probes.map(async probe => {
  const base = { id: probe.id, name: probe.name, keyPresent: !!env[probe.env], checkedAt: new Date().toISOString() }
  if (!base.keyPresent) return { ...base, status: 'missing_key' }
  try {
    const response = await fetch(probe.request(), { signal: AbortSignal.timeout(20000), redirect: 'error' })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const body = new TextDecoder().decode(bytes)
    let data
    try { data = JSON.parse(body) } catch { /* XML is supported below */ }
    const root = data && Object.values(data).find(v => v && typeof v === 'object' && 'RESULT' in v)
    const code = root?.RESULT?.CODE ?? data?.RESULT?.CODE ?? data?.response?.header?.resultCode ?? body.match(/<(?:resultCode|returnReasonCode|headerCd)>([^<]*)</)?.[1]
    const imageOk = probe.image && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    const rows = root?.row ?? (Array.isArray(data) ? data : data?.response?.body?.items?.item)
    const count = Array.isArray(rows) ? rows.length : (body.match(/<item>/g) || []).length
    // HTTP 200 alone is never authentication/data success.
    const valid = imageOk || (response.ok && (code === 'INFO-000' || code === '00' || code === '0' || code === '0000') && count > 0) || (response.ok && Array.isArray(data) && data.length > 0)
    const safeCode = typeof code === 'string' && /^[\w-]{1,20}$/.test(code) ? code : null
    return { ...base, status: valid ? 'verified' : 'unverified_response', httpStatus: response.status, responseCode: safeCode, sampleCount: imageOk ? null : count, contentType: response.headers.get('content-type')?.split(';')[0] }
  } catch (error) {
    return { ...base, status: 'network_error', reason: error.name === 'TimeoutError' ? 'timeout' : 'connection_or_redirect_failed' }
  }
}))
await mkdir('data', { recursive: true })
await writeFile('data/api-verification.json', JSON.stringify(report, null, 2) + '\n')
console.table(report.map(({ name, status, httpStatus, responseCode, sampleCount }) => ({ name, status, httpStatus, responseCode, sampleCount })))
console.log('비밀키를 제외한 검증 결과: data/api-verification.json')
if (report.some(r => r.status !== 'verified')) process.exitCode = 1
