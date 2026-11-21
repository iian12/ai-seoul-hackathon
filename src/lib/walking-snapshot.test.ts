import test from 'node:test'
import assert from 'node:assert/strict'
import { demoSnapshot } from './demo.ts'
import { attachWalking } from './walking-snapshot.ts'
import { DEFAULT_WEIGHTS, recommend, validateSnapshot } from './recommend.ts'
import type { WalkingData } from './walking-snapshot.ts'

function data(): WalkingData {
  return { report: { extract: { url: 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf', lastModified: 'Sat, 14 Nov 2026 16:19:11 GMT', downloadedAt: '2026-11-16T00:00:00Z' } }, areas: Object.fromEntries(demoSnapshot.areas.map((a, i) => [a.code, { status: i === 1 ? 'no_connected_entrance' : 'ok', origin: { latitude: a.latitude, longitude: a.longitude }, sourceId: 'walking-osm', checkedAt: '2026-11-16T00:00:00Z', distanceM: 200 + i * 100, durationSeconds: (200 + i * 100) / 1.25, originSnapM: 10, destinationSnapM: 2, geometry: { type: 'LineString', coordinates: [[a.longitude, a.latitude], [a.longitude + .001, a.latitude]] } }])) }
}
function snapshot() { const s = structuredClone(demoSnapshot); s.isDemo = false; s.areas.forEach(a => { a.metrics = { busDistanceM: 100 } }); return s }

test('walking snapshot preserves budgets and joint rental groups while replacing station score', () => {
  const s = snapshot(), budget = { maxDepositKrw: 10000000, maxMonthlyRentKrw: 650000 }
  const next = attachWalking(s, data()); validateSnapshot(next)
  assert.equal(next.modelVersion, 'seoul-walking-1.0')
  assert.equal(next.sources.find(s => s.id === 'walking-osm')!.observedDate, '2026-11-15')
  assert.deepEqual(next.areas.map(a => a.transactions), s.areas.map(a => a.transactions))
  assert.deepEqual(recommend(next, budget, DEFAULT_WEIGHTS).budget, budget)
  assert.equal(recommend(next, { maxDepositKrw: 0, maxMonthlyRentKrw: 0 }, DEFAULT_WEIGHTS).recommendations.length, 0)
})
test('unverified foot routes are excluded even if old straight-distance score was high', () => {
  const next = attachWalking(snapshot(), data())
  assert.equal(next.areas[1].scores.transit, null)
  const result = recommend(next, { maxDepositKrw: 1000000000, maxMonthlyRentKrw: 10000000 }, DEFAULT_WEIGHTS)
  assert.match(result.excluded.find(e => e.area.code === next.areas[1].code)!.reason, /보행 네트워크/)
})
test('stale route origins and excessive off-network corrections are rejected', () => {
  const stale = data(); stale.areas[demoSnapshot.areas[0].code].origin!.latitude += .01
  assert.throws(() => attachWalking(snapshot(), stale), /대표점/)
  const next = attachWalking(snapshot(), data()); next.areas[0].walking!.destinationSnapM = 100
  assert.throws(() => validateSnapshot(next), /도착점/)
})
