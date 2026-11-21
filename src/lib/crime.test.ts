import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attachCrime, validateCrime } from './crime.ts'
import { demoSnapshot } from './demo.ts'
import { recommend, DEFAULT_WEIGHTS, parseBudget, validateSnapshot } from './recommend.ts'
const data = JSON.parse(readFileSync(new URL('../data/district-crime-2025.json', import.meta.url), 'utf8'))
test('official district populations reconcile and rates use unrounded counts', () => {
  assert.equal(data.districts.length, 25)
  assert.equal(data.districts.reduce((n: number, d: { population: number }) => n + d.population, 0), 9299548)
  for (const c of data.districts) validateCrime(c, c.district)
  assert.throws(() => validateCrime({ ...data.districts[0], population: 0 }, data.districts[0].district))
  assert.throws(() => validateCrime({ ...data.districts[0], per100k: 1 }, data.districts[0].district))
})
test('district statistics remain separate from neighborhood scores and rankings', () => {
  const s = structuredClone(demoSnapshot), budget = parseBudget('1000', '65')
  const before = recommend(s, budget, DEFAULT_WEIGHTS)
  const scores = s.areas.map(a => ({ ...a.scores }))
  attachCrime(s, data, data.retrievedAt); validateSnapshot(s)
  assert.deepEqual(s.areas.map(a => a.scores), scores)
  assert.deepEqual(recommend(s, budget, DEFAULT_WEIGHTS).recommendations.map(r => [r.area.code, r.totalScore]), before.recommendations.map(r => [r.area.code, r.totalScore]))
  assert.ok(s.areas.every(a => a.crime?.district === a.district && a.crime.year === 2025))
  assert.throws(() => attachCrime(structuredClone(s), { ...data, districts: data.districts.slice(1) }, data.retrievedAt))
})

test('policing ranks independent districts and never changes facility scores', async () => {
  const { applyPolicingScores } = await import('./crime.ts')
  const template = demoSnapshot.areas[0]
  const s = structuredClone(demoSnapshot)
  s.areas = data.districts.map((c: { district: string }, i: number) => ({ ...structuredClone(template), code: String(i), district: c.district }))
  attachCrime(s, data, data.retrievedAt)
  const safety = s.areas.map(a => a.scores.safety)
  applyPolicingScores(s)
  const ordered = [...s.areas].sort((a,b) => a.crime!.per100k-b.crime!.per100k)
  assert.equal(ordered[0].scores.policing, 100)
  assert.equal(ordered.at(-1)!.scores.policing, 0)
  assert.deepEqual(s.areas.map(a => a.scores.safety), safety)
  const same = structuredClone(ordered[0]); same.code='duplicate'; s.areas.push(same)
  applyPolicingScores(s)
  assert.equal(same.scores.policing, ordered[0].scores.policing)
  for (const a of s.areas) a.walking = { status: 'ok', sourceId:'test', checkedAt:'2026-11-21', origin: {latitude:a.latitude,longitude:a.longitude} }
  const budget = parseBudget('10000', '1000')
  const selected = recommend(s, budget, { safety:0,transit:0,housing:0,medical:0,policing:100 })
  assert.equal(selected.recommendations[0].componentScores.policing,100)
  s.areas = s.areas.filter(a => a.district !== ordered.at(-1)!.district)
  assert.throws(() => applyPolicingScores(s), /25개/)
})
