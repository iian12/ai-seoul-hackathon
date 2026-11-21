import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/pick.js'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import chain from 'stream-chain'

const root = 'data/full-seoul', folder = `${root}/tbLnOpendataRentV`
const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date()))
const years = [currentYear - 2, currentYear - 1, currentYear]
await mkdir(folder, { recursive: true })
const report = JSON.parse(await readFile(`${root}/report.json`, 'utf8'))
if ((await readdir(folder)).some(f => /^\d{6}\.json.gz$/.test(f))) {
  await rename(folder, `${root}/rent-unfiltered-partial-${Date.now()}`)
  await mkdir(folder)
}
const state = report.sources.tbLnOpendataRentV = { status: 'running', expected: 0, rows: 0, pages: 0, fetchedPages: 0, years: {}, method: 'API year-partitioned pages; official bulk JSON only if year and row count match API' }
let saving = Promise.resolve()
function save() { saving = saving.then(() => writeFile(`${root}/report.json`, JSON.stringify(report, null, 2))); return saving }
async function page(year, start, end) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(process.env.SEOUL_OPEN_DATA_API_KEY)}/json/tbLnOpendataRentV/${start}/${end}/${year}/`, { signal: AbortSignal.timeout(45000), redirect: 'error' })
      const data = await r.json(), d = data.tbLnOpendataRentV
      if (!r.ok || d?.RESULT?.CODE !== 'INFO-000' || !Array.isArray(d.row) || d.row.some(x => String(x.RCPT_YR) !== String(year))) throw new Error('invalid_response')
      return { total: d.list_total_count, rows: d.row }
    } catch { if (attempt === 3) throw new Error('rental_page_failed'); await new Promise(r => setTimeout(r, 1500 * (attempt + 1))) }
  }
}
const writePage = async (name, data) => { await writeFile(`${folder}/${name}.tmp`, gzipSync(JSON.stringify(data))); await rename(`${folder}/${name}.tmp`, `${folder}/${name}`) }
try {
  for (const year of years) {
    const probe = await page(year, 1, 1)
    state.years[year] = { expected: Number(probe.total), rows: 0, status: 'pending' }
    state.expected += Number(probe.total); state.pages += Math.ceil(Number(probe.total) / 1000)
  }
  // The exact current-year export was obtained using the provider's own unchanged form parameters.
  if (!(await readdir(folder)).some(f => f.startsWith(`${currentYear}-`))) {
    let buffer = [], count = 0, index = 1
    const pipeline = chain([createReadStream('data/current-year-bulk.json'), parser(), pick({ filter: 'DATA' }), streamArray()])
    for await (const { value } of pipeline) {
      const row = Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toUpperCase(), v]))
      if (String(row.RCPT_YR) !== String(currentYear)) throw new Error('bulk_wrong_year')
      buffer.push(row); count++
      if (buffer.length === 1000) { await writePage(`${currentYear}-${String(index++).padStart(6, '0')}.json.gz`, { total: state.years[currentYear].expected, rows: buffer }); buffer = [] }
    }
    if (buffer.length) await writePage(`${currentYear}-${String(index).padStart(6, '0')}.json.gz`, { total: state.years[currentYear].expected, rows: buffer })
    if (count !== state.years[currentYear].expected) throw new Error('bulk_count_mismatch')
    console.log(`${currentYear} bulk verified: ${count} rows`)
  }
  const jobs = []
  for (const year of [...years].reverse()) for (let start = 1; start <= state.years[year].expected; start += 1000) jobs.push({ year, start, end: Math.min(start + 999, state.years[year].expected), name: `${year}-${String(Math.floor(start / 1000) + 1).padStart(6, '0')}.json.gz` })
  let cursor = 0
  const workers = await Promise.allSettled(Array.from({ length: 8 }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      let d
      try { d = JSON.parse(gunzipSync(await readFile(`${folder}/${job.name}`))) } catch { d = await page(job.year, job.start, job.end); await writePage(job.name, d) }
      if (Number(d.total) !== state.years[job.year].expected || d.rows.length !== job.end - job.start + 1) throw new Error('count_mismatch')
      state.fetchedPages++; state.rows += d.rows.length; state.years[job.year].rows += d.rows.length
      if (state.fetchedPages % 100 === 0 || state.fetchedPages === jobs.length) { console.log(`전월세 ${state.fetchedPages}/${jobs.length} pages · ${state.rows}/${state.expected} rows`); await save() }
    }
  }))
  if (workers.some(r => r.status === 'rejected')) throw new Error('some_pages_failed_resume_from_cache')
  for (const item of Object.values(state.years)) item.status = item.rows === item.expected ? 'complete' : 'count_mismatch'
  state.status = state.rows === state.expected ? 'complete' : 'count_mismatch'
  state.completedAt = new Date().toISOString(); report.finishedAt = state.completedAt
  await save(); console.log('전월세 전체 수집·건수 대조 완료')
} catch {
  state.status = 'failed'; await save(); console.error('전월세 분할 수집 미완료. 캐시를 보존했습니다. 재실행하면 이어받습니다.'); process.exitCode = 1
}
