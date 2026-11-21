import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'

const dir = 'data/full-seoul'
await mkdir(dir, { recursive: true })
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false })
const report = { startedAt: new Date().toISOString(), sources: {}, errors: [] }
const checkpoint = async () => { await writeFile(`${dir}/report.tmp`, JSON.stringify(report, null, 2)); await rename(`${dir}/report.tmp`, `${dir}/report.json`) }
const secrets = Object.entries(process.env).filter(([k]) => /KEY/.test(k)).map(([, v]) => v).filter(Boolean)
async function request(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45000), redirect: 'error' })
      if (!r.ok) throw new Error(`http_${r.status}`)
      const body = await r.text()
      if (secrets.some(s => body.includes(s))) throw new Error('secret_echo')
      return body
    } catch { if (attempt === 3) throw new Error('request_failed'); await new Promise(r => setTimeout(r, 1000 * (attempt + 1))) }
  }
}
async function cached(id, page, fetcher) {
  const path = `${dir}/${id}/${String(page).padStart(6, '0')}.json.gz`
  try { return JSON.parse(gunzipSync(await readFile(path))) } catch { /* fetch absent or corrupt page */ }
  const data = await fetcher()
  await writeFile(`${path}.tmp`, gzipSync(JSON.stringify(data)))
  await rename(`${path}.tmp`, path)
  return data
}
async function paged(id, size, fetcher) {
  await mkdir(`${dir}/${id}`, { recursive: true })
  const first = await cached(id, 1, () => fetcher(1, size))
  const total = Number(first.total), pages = Math.ceil(total / size)
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('invalid_total')
  const state = report.sources[id] = { status: 'running', expected: total, pages, fetchedPages: 1, rows: first.rows.length, firstFields: Object.keys(first.rows[0] || {}), observedDates: [], completedAt: null }
  await checkpoint(); console.log(`${id}: ${total} rows / ${pages} pages`)
  let cursor = 2, drift = false
  const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (cursor <= pages) {
      const page = cursor++
      const d = await cached(id, page, () => fetcher(page, size))
      if (Number(d.total) !== total) drift = true
      const expected = Math.min(size, total - (page - 1) * size)
      if (d.rows.length !== expected) throw new Error('short_page')
      state.fetchedPages++; state.rows += d.rows.length
      if (state.fetchedPages % 100 === 0 || state.fetchedPages === pages) { console.log(`${id}: ${state.fetchedPages}/${pages} pages, ${state.rows} rows`); await checkpoint() }
    }
  }))
  if (workers.some(r => r.status === 'rejected')) throw new Error('pages_failed')
  state.status = drift ? 'total_changed' : state.rows === total ? 'complete' : 'count_mismatch'
  state.completedAt = new Date().toISOString()
  await checkpoint()
}
async function seoul(service) {
  return paged(service, 1000, async (page, size) => {
    const start = (page - 1) * size + 1
    const d = JSON.parse(await request(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(process.env.SEOUL_OPEN_DATA_API_KEY)}/json/${service}/${start}/${start + size - 1}/`))
    const root = d[service]
    if (root?.RESULT?.CODE !== 'INFO-000' || !Array.isArray(root.row)) throw new Error('api_response')
    return { total: root.list_total_count, rows: root.row }
  })
}
async function medical(id, path, params) {
  return paged(id, 1000, async (page, size) => {
    const url = new URL(`https://apis.data.go.kr/${path}`)
    url.search = new URLSearchParams({ serviceKey: decodeURIComponent(process.env.DATA_GO_KR_SERVICE_KEY), numOfRows: String(size), pageNo: String(page), ...params })
    const root = parser.parse(await request(url)).response
    if (!['00', '0'].includes(String(root?.header?.resultCode))) throw new Error('api_response')
    const items = root.body.items?.item
    return { total: root.body.totalCount, rows: Array.isArray(items) ? items : items ? [items] : [] }
  })
}
const tasks = [
  ...['subwayStationMaster', 'busStopLocationXyInfo', 'tbSafeReturnItem', 'tbSafeReturnRouteLink', 'tbSafeReturnService'].map(id => [id, () => seoul(id)]),
  ['hira-hospital', () => medical('hira-hospital', 'B551182/hospInfoServicev2/getHospBasisList', { sidoCd: '110000' })],
  ['nmc-pharmacy', () => medical('nmc-pharmacy', 'B552657/ErmctInsttInfoInqireService/getParmacyListInfoInqire', { Q0: '서울특별시' })],
  ['nmc-hospital', () => medical('nmc-hospital', 'B552657/HsptlAsembySearchService/getHsptlMdcncListInfoInqire', { Q0: '서울특별시' })],
  ['nmc-emergency', () => medical('nmc-emergency', 'B552657/ErmctInfoInqireService/getEgytListInfoInqire', { Q0: '서울특별시' })],
]
for (const [id, task] of tasks) {
  try { await task() } catch { report.errors.push({ source: id, code: 'collection_failed', at: new Date().toISOString() }); if (report.sources[id]) report.sources[id].status = 'failed'; console.log(`${id}: failed; cached pages retained`); await checkpoint() }
}
report.finishedAt = new Date().toISOString(); await checkpoint()
console.log('Collection finished. See data/full-seoul/report.json')
if (report.errors.length || Object.values(report.sources).some(s => s.status !== 'complete')) process.exitCode = 1
