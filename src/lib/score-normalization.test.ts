import test from 'node:test'
import assert from 'node:assert/strict'
import { calibrateScores, scoreMetric, applyPercentileScores } from './score-normalization.ts'
import { demoSnapshot } from './demo.ts'
import { measurePoint } from '../ui/pointCheck.ts'
import type { PointData } from '../ui/pointCheck.ts'

test('oppositely skewed domains have equal spread without clipping tail ranks', () => {
  for (const values of [Array.from({ length: 1001 }, (_, i) => (i / 1000) ** 8), Array.from({ length: 1001 }, (_, i) => 1 - (i / 1000) ** 4)]) {
    const calibration = calibrateScores(values)
    const scores = values.map(v => scoreMetric(v, calibration)).sort((a, b) => a - b)
    assert.ok(Math.abs(scores.reduce((a, b) => a + b) / scores.length - 50) < 1e-10)
    for (let i = 0; i < scores.length; i++) assert.ok(Math.abs(scores[i] - i / 10) < 1e-10)
    assert.equal(scores.filter(s => s === 0).length, 1)
    assert.equal(scores.filter(s => s === 100).length, 1)
  }
})

test('ties receive average ranks; constants stay neutral; inputs are not mutated', () => {
  const values = [10, 0, 0, 30, 20]
  const c = calibrateScores(values)
  assert.equal(scoreMetric(0, c), 12.5)
  assert.equal(scoreMetric(10, c), 50)
  assert.deepEqual(values, [10, 0, 0, 30, 20])
  for (const constant of [[7], [7, 7, 7]]) assert.equal(scoreMetric(7, calibrateScores(constant)), 50)
  assert.throws(() => calibrateScores([]))
  assert.throws(() => calibrateScores([1, NaN]))
  assert.throws(() => scoreMetric(Infinity, c))
})

test('map values interpolate against a fixed reference and legacy data still loads', () => {
  const c = calibrateScores([0, 10, 30])
  assert.equal(scoreMetric(5, c), 25)
  assert.equal(scoreMetric(20, c), 75)
  assert.equal(scoreMetric(-1, c), 0)
  assert.equal(scoreMetric(31, c), 100)
  assert.equal(scoreMetric(15, { p5: 10, p95: 20 }), 50)
})

test('rescore preserves missing data and source records; unverified routes never enter the reference', () => {
  const s = structuredClone(demoSnapshot)
  for (const [i, area] of s.areas.entries()) {
    area.metrics = { safetyRaw: i ** 3, transitRaw: i ** 2, medicalRaw: 100 - i ** 3 }
    area.walking = { status: i === 1 ? 'no_connected_entrance' : 'ok', sourceId: 'walking-osm', checkedAt: '2026-11-21T00:00:00Z' }
  }
  const records = structuredClone(s.areas.map(a => ({ transactions: a.transactions, metrics: a.metrics, walking: a.walking })))
  applyPercentileScores(s)
  assert.equal(s.modelVersion, 'seoul-percentile-3.0')
  assert.equal(s.areas[1].scores.transit, null)
  assert.equal(s.areas[7].scores.safety, null)
  assert.deepEqual(s.areas.map(a => ({ transactions: a.transactions, metrics: a.metrics, walking: a.walking })), records)
  const reference = s.calculation!.transitNormalization as ReturnType<typeof calibrateScores>
  assert.equal(reference.sampleCount, s.areas.length - 1)
  assert.ok(!reference.knots.some(k => k.value === 1))
  const before = structuredClone(s)
  applyPercentileScores(s)
  assert.deepEqual(s, before)
})

test('point checks use the same percentile calibration as representative scores', () => {
  const rawTransit = .6 * Math.exp(-100 / 500) + .4
  const reference = (v: number) => calibrateScores([v - .1, v, v + .1])
  const point = new Float64Array([37.5, 127])
  const data: PointData = {
    grid: { stepM: 100, lat0: 37.5, lon0: 127, dLat: .001, dLon: .001, rows: 1, cols: 1 },
    stations: ['테스트역'], stationPlaces: [], snapshotId: 'test',
    norm: { safety: reference(.6), transit: reference(rawTransit), medical: reference(1) },
    pts: { bus: point, safety: point, cctv: point, bell: new Float64Array(), hospitals: point, pharmacies: point, emergency: point, night: point },
    meters: new Uint16Array([100]), seconds: new Uint16Array([80]), station: new Uint16Array([0]),
  }
  assert.deepEqual(measurePoint(data, 37.5, 127).scores, { safety: 50, transit: 50, medical: 50 })
  data.meters[0] = 0xffff
  assert.equal(measurePoint(data, 37.5, 127).scores.transit, null)
})
