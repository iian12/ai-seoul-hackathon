import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { validateSnapshot, recommend, DEFAULT_WEIGHTS, median, parseBudget } from '../src/lib/recommend.ts'
import type { Snapshot } from '../src/lib/types.ts'
import { RENTAL_WINDOW_MONTHS, rentalWindowStart } from '../src/lib/rental-window.ts'

const snapshot: Snapshot = JSON.parse(await readFile(process.env.SNAPSHOT_FILE ?? 'public/data/seoul-snapshot.json', 'utf8'))
validateSnapshot(snapshot)
assert.equal(snapshot.isDemo, false)
assert.equal(new Set(snapshot.areas.map(a => a.district)).size, 25)
const qa = JSON.parse(await readFile(process.env.AGGREGATION_REPORT_FILE ?? 'data/full-seoul/aggregation-report.json', 'utf8'))
assert.equal(qa.rentalWindow.months, RENTAL_WINDOW_MONTHS)
assert.equal(qa.rentalWindow.start, snapshot.periodStart)
assert.equal(qa.rentalWindow.end, snapshot.periodEnd)
assert.equal(snapshot.periodStart, [qa.rentalWindow.allPeriodStart, rentalWindowStart(snapshot.periodEnd)].sort().at(-1))
const report = JSON.parse(await readFile('data/full-seoul/report.json', 'utf8'))
assert.equal(report.sources.tbLnOpendataRentV.status, 'complete')
assert.equal(qa.mapping.sourceRows, report.sources.tbLnOpendataRentV.expected)
assert.equal(snapshot.areas.reduce((n, a) => n + (a.rentalGroups ?? []).reduce((m, g) => m + g.count, 0), 0), qa.mapping.acceptedMonthlyRows)
const budget = { maxDepositKrw: 10000000, maxMonthlyRentKrw: 650000 }
const result = recommend(snapshot, budget, DEFAULT_WEIGHTS)
assert.equal(result.recommendations.length, 3)
const db = new DatabaseSync('data/full-seoul/rentals-build.sqlite', { readOnly: true })
for (const r of result.recommendations) {
  const exact = db.prepare('select count(*) as n from rental where area=? and deposit<=? and rent<=? and date>=? and date<=?').get(r.area.code, budget.maxDepositKrw, budget.maxMonthlyRentKrw, snapshot.periodStart, snapshot.periodEnd)!
  assert.equal(r.budgetMatchCount, Number(exact.n))
  const raw = db.prepare('select rent from rental where area=? and date>=? and date<=?').all(r.area.code, snapshot.periodStart, snapshot.periodEnd).map(row => Number(row.rent))
  assert.equal(r.sampleCount, raw.length)
  assert.equal(r.medianRentKrw, median(raw))
  assert.ok(r.budgetMatchCount >= 10)
  const headroom = Math.max(0, Math.min(100, 100 * (budget.maxMonthlyRentKrw - median(raw)) / budget.maxMonthlyRentKrw))
  assert.ok(Math.abs(r.componentScores.housing - (60 * Number(exact.n) / raw.length + .4 * headroom)) < 1e-10)
}
assert.equal(snapshot.areas.reduce((n, a) => n + (a.jeonseGroups ?? []).reduce((m, g) => m + g.count, 0), 0), qa.mapping.acceptedJeonseRows)
const jeonseBudget = parseBudget('30000', '', 'jeonse')
const jeonse = recommend(snapshot, jeonseBudget, DEFAULT_WEIGHTS)
assert.equal(jeonse.recommendations.length, 3)
for (const r of jeonse.recommendations) {
  const exact = db.prepare('select count(*) as n from jeonse where area=? and deposit<=? and date>=? and date<=?').get(r.area.code, jeonseBudget.maxDepositKrw, snapshot.periodStart, snapshot.periodEnd)!
  const deposits = db.prepare('select deposit from jeonse where area=? and date>=? and date<=?').all(r.area.code, snapshot.periodStart, snapshot.periodEnd).map(row => Number(row.deposit))
  assert.equal(r.budgetMatchCount, Number(exact.n))
  assert.equal(r.sampleCount, deposits.length)
  assert.equal(r.medianDepositKrw, median(deposits))
  assert.ok(r.budgetMatchCount >= 10)
  const headroom = Math.max(0, Math.min(100, 100 * (jeonseBudget.maxDepositKrw - median(deposits)) / jeonseBudget.maxDepositKrw))
  assert.ok(Math.abs(r.componentScores.housing - (60 * Number(exact.n) / deposits.length + .4 * headroom)) < 1e-10)
}
assert.equal(recommend(snapshot, parseBudget('0', '', 'jeonse'), DEFAULT_WEIGHTS).candidateCount, 0)
const anchor = { name: '서울시청', latitude: 37.5665, longitude: 126.978, radiusKm: 3 }
const scopedJeonse = recommend(snapshot, jeonseBudget, DEFAULT_WEIGHTS, anchor)
assert.ok(scopedJeonse.recommendations.length > 0)
assert.ok(scopedJeonse.excluded.some(e => e.reason.includes('반경')))
console.log(JSON.stringify({ jeonse: 'PASS', includedJeonseRows: qa.mapping.acceptedJeonseRows, top3SqlParity: true, candidateCount: jeonse.candidateCount, recommended: jeonse.recommendations.map(r => ({ area: `${r.area.district} ${r.area.name}`, matches: r.budgetMatchCount, medianDepositKrw: r.medianDepositKrw })) }, null, 2))
// Low-budget regression: count eligible areas directly from the source SQL.
const lowBudget = parseBudget('500', '30')
const lowResult = recommend(snapshot, lowBudget, DEFAULT_WEIGHTS)
const affordableRows = db.prepare('select area,count(*) as n from rental where deposit<=? and rent<=? and date>=? and date<=? group by area having count(*)>=10').all(lowBudget.maxDepositKrw, lowBudget.maxMonthlyRentKrw, snapshot.periodStart, snapshot.periodEnd)
const affordable = new Map(affordableRows.map(row => [String(row.area), Number(row.n)]))
const eligible = snapshot.areas.filter(a => affordable.has(a.code) && a.walking?.status === 'ok' && ['safety', 'transit', 'medical'].every(k => Number.isFinite(a.scores[k as keyof typeof a.scores])))
assert.equal(lowResult.candidateCount, eligible.length)
assert.equal(lowResult.recommendations.length, Math.min(3, eligible.length))
assert.ok(!lowResult.excluded.some(e => e.reason.includes('중간값')))
for (const r of lowResult.recommendations) assert.equal(r.budgetMatchCount, affordable.get(r.area.code))
console.log(JSON.stringify({ lowBudget: '500/30 PASS', candidateCount: lowResult.candidateCount, top3SqlParity: true }))
db.close()
assert.equal(recommend(snapshot, { maxDepositKrw: 0, maxMonthlyRentKrw: 0 }, DEFAULT_WEIGHTS).recommendations.length, 0)
assert.deepEqual(result, recommend(snapshot, budget, DEFAULT_WEIGHTS))
console.log(JSON.stringify({ status: 'PASS', regions: snapshot.areas.length, districts: 25, sourceRentalRows: qa.mapping.sourceRows, includedMonthlyRows: qa.mapping.acceptedMonthlyRows, top3SqlParity: true, recommended: result.recommendations.map(r => ({ code: r.area.code, area: `${r.area.district} ${r.area.name}`, score: r.totalScore, matches: r.budgetMatchCount })), candidateCount: result.candidateCount }, null, 2))
if (['seoul-walking-1.0', 'seoul-enriched-2.0', 'seoul-percentile-3.0', 'seoul-five-domain-4.0'].includes(snapshot.modelVersion)) {
  let verified = 0
  for (const area of snapshot.areas) {
    if (area.walking?.status !== 'ok') { assert.equal(area.scores.transit, null); continue }
    const walk = area.walking, coords = walk.geometry!.coordinates
    let sum = 0
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i], rad = Math.PI / 180
      const dy = (b[1] - a[1]) * rad, dx = (b[0] - a[0]) * rad
      const h = Math.sin(dy / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dx / 2) ** 2
      sum += 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
    }
    assert.ok(Math.abs(sum - walk.distanceM!) < 1, `Walking line length mismatch: ${area.code}`)
    assert.ok(walk.originSnapM! <= 100 && (walk.destinationSnapM ?? 0) <= 20)
    assert.ok(walk.durationSeconds! >= walk.distanceM! / 1.25 - 1)
    verified++
  }
  assert.ok(verified > snapshot.areas.length / 2)
  assert.ok(result.recommendations.every(r => r.area.walking?.status === 'ok'))
  console.log(`도보 경로 ${verified}개 선 길이·시간·보정 한도 검증 PASS, 미확인 지역은 추천 제외`)
}
