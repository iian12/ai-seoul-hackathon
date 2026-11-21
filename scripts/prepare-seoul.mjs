import { mkdir, writeFile, rename, access } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gzipSync } from 'node:zlib'

await mkdir('data/full-seoul/tdata-subway', { recursive: true })
await access('src/data/seoul-legal-boundaries.json')
try { await access('data/current-year-bulk.json') } catch {
  const params = { srvType: 'S', infId: 'OA-21276', serviceKind: '0', pageNo: '1', ssUserId: 'SAMPLE_VIEW', strWhere: " AND RCPT_YR >= TO_CHAR(NOW(), 'YYYY')", strOrderby: 'CTRT_DAY DESC', gridTotalCnt: '', filterCol: '', txtFilter: '' }
  const response = await fetch('https://datafile.seoul.go.kr/bigfile/iot/sheet/json/download.do', { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error('현재 연도 일괄 JSON 수집 실패')
  await pipeline(Readable.fromWeb(response.body), createWriteStream('data/current-year-bulk.tmp'))
  await rename('data/current-year-bulk.tmp', 'data/current-year-bulk.json')
}
let count = 0, page = 1, previous = ''
for (; page < 100; page++) {
  const url = new URL('https://t-data.seoul.go.kr/apig/apiman-gateway/tapi/TaimsKsccDvSubwayStationGeom/1.0')
  url.search = new URLSearchParams({ apikey: process.env.TDATA_API_KEY, startRow: String((page - 1) * 1000 + 1), rowCnt: '1000' })
  let data
  try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); data = await r.json(); if (!r.ok || !Array.isArray(data)) throw new Error('response') } catch { throw new Error('T-Data 전체 수집 실패') }
  const json = JSON.stringify(data)
  if (json === previous && data.length) throw new Error('T-Data 반복 페이지')
  previous = json; count += data.length
  await writeFile(`data/full-seoul/tdata-subway/${String(page).padStart(6, '0')}.json.gz`, gzipSync(json))
  if (data.length < 1000) break
}
if (page === 100) throw new Error('T-Data 페이지 수 확인 필요')
await writeFile('data/full-seoul/aux-report.json', JSON.stringify({ tdataSubway: { status: 'complete', rows: count, pages: page, checkedAt: new Date().toISOString(), usage: '역사마스터 대체 원천. 중복 합산하지 않음.' } }, null, 2))
console.log(`공개 경계·현재 연도 일괄 JSON 준비, T-Data ${count}건 수집 완료`)
