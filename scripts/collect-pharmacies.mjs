import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'

const root = 'data/full-seoul', parser = new XMLParser({ parseTagValue: false })
async function query(params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = new URL('https://apis.data.go.kr/B551182/pharmacyInfoService/getParmacyBasisList')
      url.search = new URLSearchParams({ serviceKey: decodeURIComponent(process.env.DATA_GO_KR_SERVICE_KEY), sidoCd: '110000', pageNo: '1', numOfRows: '1000', ...params })
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      const data = parser.parse(await response.text()).response
      if (!response.ok || data?.header?.resultCode !== '00') throw new Error('response')
      const items = data.body.items?.item
      return { total: Number(data.body.totalCount), rows: Array.isArray(items) ? items : items ? [items] : [] }
    } catch { if (attempt === 2) throw new Error('약국 수집 실패') }
  }
}
async function inspect(folder) {
  const ids = new Set(); let count = 0, pages = 0
  for (const f of (await readdir(folder)).filter(f => f.endsWith('.json.gz'))) {
    const data = JSON.parse(gunzipSync(await readFile(`${folder}/${f}`)))
    for (const r of data.rows) { count++; if (!r.ykiho) throw new Error('기관 ID 누락'); ids.add(r.ykiho) }
    pages++
  }
  return { count, unique: ids.size, pages }
}
try {
  const global = await query({ numOfRows: '1' })
  let valid
  try { valid = await inspect(`${root}/hira-pharmacy`) } catch { /* no cache */ }
  if (!valid || valid.count !== global.total || valid.unique !== global.total) {
    const districts = new Set()
    for (const f of (await readdir(`${root}/hira-hospital`)).filter(f => f.endsWith('.json.gz'))) {
      const data = JSON.parse(gunzipSync(await readFile(`${root}/hira-hospital/${f}`)))
      for (const row of data.rows) if (row.sgguCd) districts.add(String(row.sgguCd))
    }
    if (districts.size !== 25) throw new Error('25개 구 코드 누락')
    const folder = `${root}/pharmacy-partition-stage-${Date.now()}`
    await mkdir(folder)
    const codes = [...districts]; let cursor = 0
    const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      while (cursor < codes.length) {
        const code = codes[cursor++]
        for (let page = 1, total = Infinity; (page - 1) * 1000 < total; page++) {
          const data = await query({ sgguCd: code, pageNo: String(page) }); total = data.total
          if (data.rows.length !== Math.min(1000, total - (page - 1) * 1000)) throw new Error('분할 건수 불일치')
          await writeFile(`${folder}/${code}-${String(page).padStart(4, '0')}.json.gz`, gzipSync(JSON.stringify(data)))
        }
      }
    }))
    if (results.some(r => r.status === 'rejected')) throw new Error('일부 구 수집 실패')
    valid = await inspect(folder)
    if (valid.count !== global.total || valid.unique !== global.total) throw new Error('전체·고유 기관 건수 불일치')
    try { await rename(`${root}/hira-pharmacy`, `${root}/pharmacy-previous-${Date.now()}`) } catch { /* no old source */ }
    await rename(folder, `${root}/hira-pharmacy`)
  }
  const report = JSON.parse(await readFile(`${root}/report.json`, 'utf8'))
  report.sources['hira-pharmacy'] = { status: 'complete', expected: global.total, rows: valid.count, uniqueIds: valid.unique, pages: valid.pages, fetchedPages: valid.pages, method: '25 districts partitioned; unique institution count reconciled with global total', completedAt: new Date().toISOString() }
  await writeFile(`${root}/report.json`, JSON.stringify(report, null, 2))
  console.log(`심평원 약국 전체·고유 기관 ${valid.count}건 일치 확인`)
} catch { console.error('약국 전체 기관 대조 실패. 이전 캐시·공개 정상본을 유지합니다.'); process.exitCode = 1 }
