import test from 'node:test'
import assert from 'node:assert/strict'
import { distanceM, searchPlaces, validateLocation, withinRadius } from './location.ts'
import { recommend, DEFAULT_WEIGHTS } from './recommend.ts'
import { demoSnapshot } from './demo.ts'
import type { LocationFilter } from './types.ts'

const anchor: LocationFilter = { name: '학교', latitude: 37.5665, longitude: 126.978, radiusKm: 3 }
test('radius is a geodesic straight distance and includes the exact boundary', () => {
  assert.equal(distanceM(anchor, anchor), 0)
  const area = { ...demoSnapshot.areas[0], latitude: anchor.latitude + .01, longitude: anchor.longitude }
  const km = distanceM(area, anchor) / 1000
  assert.ok(km > 1.11 && km < 1.12)
  assert.ok(withinRadius(area, { ...anchor, radiusKm: km }))
  assert.ok(!withinRadius(area, { ...anchor, radiusKm: km - .001 }))
})
test('invalid radius and locations outside Seoul are rejected', () => {
  for (const radiusKm of [0, .49, 20.1, NaN, Infinity]) assert.throws(() => validateLocation({ ...anchor, radiusKm }))
  assert.throws(() => validateLocation({ ...anchor, latitude: 36.35, longitude: 127.38 }))
  assert.throws(() => validateLocation({ ...anchor, name: ' ' }))
  validateLocation({ ...anchor, radiusKm: .5 }); validateLocation({ ...anchor, radiusKm: 20 })
})
test('radius filters all candidates before ranking while preserving budget and scores', () => {
  const snapshot = structuredClone(demoSnapshot)
  const budget = { maxDepositKrw: 10000000, maxMonthlyRentKrw: 650000 }
  const original = recommend(snapshot, budget, DEFAULT_WEIGHTS)
  const point = original.recommendations[0].area
  const location = { name: '직장', latitude: point.latitude, longitude: point.longitude, radiusKm: .5 }
  const scoped = recommend(snapshot, budget, DEFAULT_WEIGHTS, location)
  assert.ok(scoped.recommendations.length)
  assert.ok(scoped.recommendations.every(r => withinRadius(r.area, location)))
  assert.deepEqual(scoped.budget, budget)
  assert.equal(scoped.recommendations[0].totalScore, original.recommendations[0].totalScore)
  assert.ok(scoped.excluded.some(r => r.reason.includes('반경')))
  assert.equal(recommend(snapshot, { maxDepositKrw: 0, maxMonthlyRentKrw: 0 }, DEFAULT_WEIGHTS, location).candidateCount, 0)
  assert.deepEqual(recommend(snapshot, budget, DEFAULT_WEIGHTS), original)
  location.radiusKm = 20
  assert.equal(scoped.locationFilter?.radiusKm, .5)
})
test('offline search handles Korean spacing and excludes places outside Seoul', () => {
  const rows = [
    { id: '1', name: '테스트 대학교', address: '서울특별시 세종대로 1', category: '학교', latitude: 37.5665, longitude: 126.978 },
    { id: '2', name: '테스트대학교 외곽', address: '', category: '학교', latitude: 36.35, longitude: 127.38 },
  ]
  assert.equal(searchPlaces(rows, '테스트대학교')[0].id, '1')
  assert.equal(searchPlaces(rows, '세종대로1')[0].id, '1')
  assert.equal(searchPlaces(rows, '테스트').length, 1)
  assert.equal(searchPlaces(rows, 'x').length, 0)
})
