import test from 'node:test'
import assert from 'node:assert/strict'
import { compareRecommendations, DEFAULT_WEIGHTS, normalizeMetric, normalizeWeights, parseBudget, recommend, validateSnapshot, weightedScore } from './recommend.ts'
import { demoSnapshot } from './demo.ts'
import { isInSeoul } from './seoul.ts'
import type { Recommendation, Snapshot, Transaction } from './types.ts'

const clone = () => structuredClone(demoSnapshot)
const budget = { maxDepositKrw: 10000000, maxMonthlyRentKrw: 650000 }
const transaction = (depositKrw = 10000000, monthlyRentKrw = 600000): Transaction => ({ id: 't', depositKrw, monthlyRentKrw, areaM2: 25, contractDate: '2026-05-01', housingType: '연립·다세대', leaseType: 'monthly' })
function fixture(n = 10): Snapshot { const s = clone(); s.areas = [s.areas[0]]; s.areas[0].transactions = Array.from({ length: n }, (_, i) => ({ ...transaction(), id: String(i) })); return s }

test('invalid, empty, negative and fractional budgets fail; 0 remains valid', () => {
  for (const value of ['', '-1', 'hello', '1.5', '1,000', 'Infinity', '9007199254740992']) assert.throws(() => parseBudget(value, '65'))
  assert.deepEqual(parseBudget('0', '0'), { maxDepositKrw: 0, maxMonthlyRentKrw: 0 })
  assert.deepEqual(parseBudget('1000', '65'), budget)
})
test('weights normalize exactly and all-zero resets explicitly', () => {
  assert.deepEqual(normalizeWeights({ safety: 30, transit: 20, housing: 10, medical: 40 }).weights, { policing: 0, safety: .3, transit: .2, housing: .1, medical: .4 })
  const zero = normalizeWeights({ safety: 0, transit: 0, housing: 0, medical: 0 })
  assert.equal(zero.reset, true); assert.equal(Object.values(zero.weights).reduce((a, b) => a + b), 1)
  assert.throws(() => normalizeWeights({ ...DEFAULT_WEIGHTS, medical: -1 }))
})
test('SRS balanced and safety examples preserve raw scores and expected rankings', () => {
  const examples = [{ name: 'A', safety: 90, transit: 60, housing: 70, medical: 50 }, { name: 'B', safety: 60, transit: 90, housing: 75, medical: 65 }, { name: 'C', safety: 70, transit: 65, housing: 85, medical: 90 }]
  const balanced = normalizeWeights({ safety:25,transit:25,housing:25,medical:25 }).weights
  const safety = normalizeWeights({ safety: 50, transit: 20, housing: 20, medical: 10 }).weights
  assert.deepEqual(examples.map(x => [x.name, weightedScore(x, balanced)]).sort((a, b) => Number(b[1]) - Number(a[1])), [['C', 77.5], ['B', 72.5], ['A', 67.5]])
  assert.deepEqual(examples.map(x => [x.name, weightedScore(x, safety)]).sort((a, b) => Number(b[1]) - Number(a[1])), [['A', 76], ['C', 74], ['B', 69.5]])
})
test('deposit and rent must both match; 9 matches are excluded and 10 pass', () => {
  const s = fixture(); s.areas[0].transactions[0].depositKrw = 10000001
  let result = recommend(s, budget, DEFAULT_WEIGHTS)
  assert.equal(result.recommendations.length, 0); assert.match(result.excluded[0].reason, /9건/)
  s.areas[0].transactions[0].depositKrw = 10000000
  result = recommend(s, budget, DEFAULT_WEIGHTS)
  assert.equal(result.recommendations[0].budgetMatchCount, 10)
  s.areas[0].transactions[0].monthlyRentKrw = 650001
  assert.equal(recommend(s, budget, DEFAULT_WEIGHTS).recommendations.length, 0)
})
test('ten affordable monthly contracts qualify despite over-budget neighborhood medians', () => {
  for (const grouped of [false, true]) for (const [depositKrw, monthlyRentKrw] of [[10000001, 600000], [10000000, 650001]]) {
    const s = fixture()
    const expensive = structuredClone(s.areas[0])
    expensive.code = 'expensive'
    expensive.scores = { safety: 100, transit: 100, medical: 100 }
    if (grouped) {
      expensive.transactions = []
      expensive.rentalGroups = [
        { depositKrw: 10000000, monthlyRentKrw: 600000, count: 10 },
        { depositKrw, monthlyRentKrw, count: 11 },
      ]
    } else expensive.transactions.push(...Array.from({ length: 11 }, () => transaction(depositKrw, monthlyRentKrw)))
    s.areas.push(expensive)
    const result = recommend(s, budget, { safety: 100, transit: 0, housing: 0, medical: 0 })
    assert.equal(result.candidateCount, 2)
    const candidate = result.recommendations.find(r => r.area.code === expensive.code)!
    assert.ok(candidate)
    assert.equal(candidate.budgetMatchCount, 10)
    assert.equal(candidate.sampleCount, 21)
    assert.equal(candidate.medianRentKrw, monthlyRentKrw)
    const rentHeadroom = Math.max(0, 100 * (budget.maxMonthlyRentKrw - monthlyRentKrw) / budget.maxMonthlyRentKrw)
    assert.ok(Math.abs(candidate.componentScores.housing - (60 * 10 / 21 + .4 * rentHeadroom)) < 1e-10)
    assert.ok(!result.excluded.some(e => e.area.code === expensive.code))
  }
})
test('monthly medians exactly at both budget ceilings remain eligible', () => {
  const s = fixture(0)
  s.areas[0].rentalGroups = [{ depositKrw: budget.maxDepositKrw, monthlyRentKrw: budget.maxMonthlyRentKrw, count: 10 }]
  assert.equal(recommend(s, budget, DEFAULT_WEIGHTS).candidateCount, 1)
})
test('invalid, out-of-period and jeonse transactions are excluded from sample counts', () => {
  const s = fixture(); const t = transaction()
  s.areas[0].transactions.push({ ...t, leaseType: 'jeonse' }, { ...t, areaM2: 0 }, { ...t, housingType: '' }, { ...t, contractDate: '2024-01-01' }, { ...t, depositKrw: -1 }, { ...t, monthlyRentKrw: 0 })
  assert.equal(recommend(s, budget, DEFAULT_WEIGHTS).recommendations[0].sampleCount, 10)
})
test('0/0 budget returns no candidates rather than changing input', () => {
  const result = recommend(clone(), parseBudget('0', '0'), DEFAULT_WEIGHTS)
  assert.equal(result.recommendations.length, 0); assert.deepEqual(result.budget, { maxDepositKrw: 0, maxMonthlyRentKrw: 0 })
})
test('missing required metrics are excluded even with zero weight', () => {
  const s = fixture(); s.areas[0].scores.medical = null
  assert.equal(recommend(s, budget, { safety: 100, transit: 0, housing: 0, medical: 0 }).recommendations.length, 0)
})
test('housing uses matching ratio and median rent headroom at current budget', () => {
  const result = recommend(fixture(), budget, DEFAULT_WEIGHTS).recommendations[0]
  assert.ok(Math.abs(result.componentScores.housing - (60 + 40 * (650000 - 600000) / 650000)) < 1e-10)
})
test('only real candidate count is returned and recommendations are deterministic', () => {
  const s = fixture(); s.areas.push({ ...structuredClone(s.areas[0]), code: 'b' })
  const first = recommend(s, budget, DEFAULT_WEIGHTS)
  assert.equal(first.recommendations.length, 2); assert.deepEqual(first, recommend(s, budget, DEFAULT_WEIGHTS))
})
test('tie breaking: exact score, ratio, sample count, code', () => {
  const a = recommend(fixture(), budget, DEFAULT_WEIGHTS).recommendations[0]
  const b: Recommendation = structuredClone(a); b.area.code = 'zz'
  assert.ok(compareRecommendations(a, b) < 0)
  b.sampleCount += 1; assert.ok(compareRecommendations(a, b) > 0)
  b.matchRatio -= .1; assert.ok(compareRecommendations(a, b) < 0)
  b.totalScore += .000001; assert.ok(compareRecommendations(a, b) > 0)
})
test('constant raw distribution returns flagged neutral 50 and reverse distance is supported', () => {
  assert.deepEqual(normalizeMetric(10, 10, 10), { score: 50, flag: 'constant_distribution' })
  assert.equal(normalizeMetric(200, 10, 100).score, 100)
  assert.equal(normalizeMetric(10, 10, 100, true).score, 100)
})
test('Seoul polygon accepts Seoul and rejects nearby cities within bounding rectangle', () => {
  assert.equal(isInSeoul(37.5665, 126.978), true)
  assert.equal(isInSeoul(37.50, 126.768), false) // Bucheon; inside broad Seoul bbox.
  assert.equal(isInSeoul(37.45, 127.14), false) // Seongnam.
  assert.equal(isInSeoul(36.35, 127.38), false)
})
test('snapshot validation enforces Seoul geometry and district membership', () => {
  validateSnapshot(demoSnapshot)
  const s = clone(); s.areas[0].latitude = 36.35
  assert.throws(() => validateSnapshot(s), /서울/)
  const b = clone(); b.areas[0].district = '분당구'
  assert.throws(() => validateSnapshot(b), /서울/)
  const result = recommend(b, budget, DEFAULT_WEIGHTS)
  assert.ok(!result.recommendations.some(r => r.area.code === b.areas[0].code))
  assert.equal(result.excluded.find(e => e.area.code === b.areas[0].code)?.reason, '서울 외 지역')
})
test('malformed remote snapshots fail before replacing previous snapshot', () => {
  for (const bad of [null, {}, { ...clone(), modelVersion: 'other' }, { ...clone(), sources: [] }]) assert.throws(() => validateSnapshot(bad))
  const s = clone(); s.areas[0].scores.safety = Number.NaN
  assert.throws(() => validateSnapshot(s))
  const url = clone(); url.sources[0].url = 'javascript:alert(1)'
  assert.throws(() => validateSnapshot(url))
})

test('joint deposit/rent groups preserve filtering, sample count and weighted median exactly', () => {
  const s = fixture(0)
  s.areas[0].rentalGroups = [
    { depositKrw: 10000000, monthlyRentKrw: 500000, count: 9 },
    { depositKrw: 10000000, monthlyRentKrw: 600000, count: 1 },
    { depositKrw: 20000000, monthlyRentKrw: 400000, count: 8 },
  ]
  validateSnapshot(s)
  const grouped = recommend(s, budget, DEFAULT_WEIGHTS).recommendations[0]
  assert.equal(grouped.budgetMatchCount, 10)
  assert.equal(grouped.sampleCount, 18)
  assert.equal(grouped.medianRentKrw, 500000)
  const expanded = structuredClone(s)
  expanded.areas[0].transactions = s.areas[0].rentalGroups.flatMap(g => Array.from({ length: g.count }, () => transaction(g.depositKrw, g.monthlyRentKrw)))
  delete expanded.areas[0].rentalGroups
  const individual = recommend(expanded, budget, DEFAULT_WEIGHTS).recommendations[0]
  assert.equal(grouped.totalScore, individual.totalScore)
  assert.equal(grouped.matchRatio, individual.matchRatio)
})

test('corrupt grouped counts or negative amounts are rejected', () => {
  for (const group of [{ depositKrw: 0, monthlyRentKrw: 100, count: -1 }, { depositKrw: -1, monthlyRentKrw: 100, count: 10 }, { depositKrw: 0, monthlyRentKrw: 0, count: 10 }]) {
    const s = fixture(0); s.areas[0].rentalGroups = [group]; assert.throws(() => validateSnapshot(s))
  }
})


test('budget-fit sort considers all candidates before selecting three and preserves weighted scores', () => {
  const s = fixture()
  s.areas = Array.from({ length: 4 }, (_, i) => {
    const a = structuredClone(s.areas[0]); a.code = `sort-${i}`; a.transactions = []
    a.scores = { safety: 100 - i * 10, transit: 100 - i * 10, medical: 100 - i * 10 }
    a.rentalGroups = [{ depositKrw: 5000000, monthlyRentKrw: 300000, count: 10 + i * 10 }, { depositKrw: 20000000, monthlyRentKrw: 900000, count: 90 - i * 10 }]
    return a
  })
  const b = parseBudget('500', '30')
  const scoreOrder = recommend(s, b, DEFAULT_WEIGHTS)
  const fitOrder = recommend(s, b, DEFAULT_WEIGHTS, undefined, 'budget-fit')
  assert.equal(fitOrder.recommendations[0].area.code, 'sort-3')
  assert.equal(fitOrder.recommendations[0].matchRatio, .4)
  const sparse = fitOrder.recommendations.find(r => r.area.code === 'sort-1')!
  assert.equal(sparse.matchedMedianDepositKrw, 5000000)
  assert.equal(sparse.matchedMedianRentKrw, 300000)
  assert.equal(sparse.medianRentKrw, 900000)
  assert.equal(sparse.totalScore, scoreOrder.recommendations.find(r => r.area.code === 'sort-1')!.totalScore)
})
