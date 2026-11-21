import test from 'node:test'
import assert from 'node:assert/strict'
import { demoSnapshot } from './demo.ts'
import { DEFAULT_WEIGHTS, parseBudget, recommend, validateSnapshot } from './recommend.ts'

function fixture() {
  const s = structuredClone(demoSnapshot)
  s.areas = [s.areas[0]]
  s.areas[0].transactions = []
  s.areas[0].rentalGroups = [{ depositKrw: 10000000, monthlyRentKrw: 600000, count: 99 }]
  s.areas[0].jeonseGroups = [{ depositKrw: 100000000, count: 10 }, { depositKrw: 300000000, count: 10 }]
  return s
}
test('jeonse parses deposit alone and does not require hidden monthly rent', () => {
  assert.deepEqual(parseBudget('20000', '', 'jeonse'), { maxDepositKrw: 200000000, maxMonthlyRentKrw: 0, leaseType: 'jeonse' })
  assert.deepEqual(parseBudget('0', 'invalid', 'jeonse'), { maxDepositKrw: 0, maxMonthlyRentKrw: 0, leaseType: 'jeonse' })
  assert.throws(() => parseBudget('', '65', 'jeonse'))
})
test('jeonse uses only jeonse samples, weighted deposit median and deposit headroom', () => {
  const result = recommend(fixture(), parseBudget('25000', '', 'jeonse'), DEFAULT_WEIGHTS).recommendations[0]
  assert.equal(result.budgetMatchCount, 10)
  assert.equal(result.sampleCount, 20)
  assert.equal(result.medianDepositKrw, 200000000)
  assert.equal(result.medianRentKrw, 0)
  assert.equal(result.componentScores.housing, 30 + 8)
  const monthly = recommend(fixture(), parseBudget('1000', '65'), DEFAULT_WEIGHTS).recommendations[0]
  assert.equal(monthly.sampleCount, 99)
  assert.equal(monthly.medianRentKrw, 600000)
})
test('jeonse minimum ten and deposit ceiling are exact; zero does not change inputs', () => {
  const s = fixture(); s.areas[0].jeonseGroups![1].count = 9; s.areas[0].jeonseGroups![0].count = 9
  assert.equal(recommend(s, parseBudget('10000', '', 'jeonse'), DEFAULT_WEIGHTS).candidateCount, 0)
  s.areas[0].jeonseGroups![0].count = 10
  assert.equal(recommend(s, parseBudget('10000', '', 'jeonse'), DEFAULT_WEIGHTS).candidateCount, 1)
  assert.equal(recommend(s, parseBudget('9999', '', 'jeonse'), DEFAULT_WEIGHTS).candidateCount, 0)
  const zero = parseBudget('0', '', 'jeonse')
  assert.equal(recommend(s, zero, DEFAULT_WEIGHTS).candidateCount, 0)
  assert.deepEqual(zero, parseBudget('0', '', 'jeonse'))
})
test('expanded jeonse transactions match grouped deposits and reject positive rent/zero deposits', () => {
  const s = fixture()
  const grouped = recommend(s, parseBudget('25000', '', 'jeonse'), DEFAULT_WEIGHTS)
  s.areas[0].transactions = s.areas[0].jeonseGroups!.flatMap(g => Array.from({ length: g.count }, (_, i) => ({ id: `${g.depositKrw}-${i}`, leaseType: 'jeonse' as const, depositKrw: g.depositKrw, monthlyRentKrw: 0, areaM2: 25, contractDate: '2026-05-01', housingType: '다세대' })))
  delete s.areas[0].jeonseGroups
  s.areas[0].transactions.push({ ...s.areas[0].transactions[0], monthlyRentKrw: 1 }, { ...s.areas[0].transactions[0], depositKrw: 0 })
  const expanded = recommend(s, parseBudget('25000', '', 'jeonse'), DEFAULT_WEIGHTS)
  assert.equal(expanded.recommendations[0].sampleCount, grouped.recommendations[0].sampleCount)
  assert.equal(expanded.recommendations[0].totalScore, grouped.recommendations[0].totalScore)
  assert.equal(expanded.recommendations[0].medianDepositKrw, grouped.recommendations[0].medianDepositKrw)
})
test('ten affordable jeonse contracts qualify and over-budget median removes only headroom', () => {
  const s = fixture()
  const budget = parseBudget('10000', '', 'jeonse')
  s.areas[0].jeonseGroups = [{ depositKrw: budget.maxDepositKrw, count: 10 }, { depositKrw: budget.maxDepositKrw + 1, count: 11 }]
  const result = recommend(s, budget, { safety: 0, transit: 100, housing: 0, medical: 0 })
  assert.equal(result.candidateCount, 1)
  const candidate = result.recommendations[0]
  assert.equal(candidate.budgetMatchCount, 10)
  assert.equal(candidate.medianDepositKrw, budget.maxDepositKrw + 1)
  assert.ok(Math.abs(candidate.componentScores.housing - 28.571428571428573) < 1e-10)
  assert.equal(result.excluded.length, 0)
  s.areas[0].jeonseGroups[1].depositKrw = budget.maxDepositKrw
  assert.equal(recommend(s, budget, DEFAULT_WEIGHTS).candidateCount, 1)
})
test('missing jeonse distributions never reuse monthly samples and malformed groups fail validation', () => {
  const s = fixture(); delete s.areas[0].jeonseGroups
  const r = recommend(s, parseBudget('30000', '', 'jeonse'), DEFAULT_WEIGHTS)
  assert.equal(r.candidateCount, 0)
  assert.ok(r.warnings.some(w => w.includes('전세 표본이 없습니다')))
  for (const group of [{ depositKrw: 0, count: 10 }, { depositKrw: -1, count: 10 }, { depositKrw: 10000, count: 1.5 }]) {
    const s = fixture(); s.areas[0].jeonseGroups = [group]; assert.throws(() => validateSnapshot(s))
  }
})

test('jeonse separately reports the matched-contract median without changing the neighborhood median', () => {
  const r = recommend(fixture(), parseBudget('25000', '', 'jeonse'), DEFAULT_WEIGHTS).recommendations[0]
  assert.equal(r.medianDepositKrw, 200000000)
  assert.equal(r.matchedMedianDepositKrw, 100000000)
  assert.equal(r.matchedMedianRentKrw, 0)
})
