import assert from 'node:assert/strict'
import test from 'node:test'
import type { Place } from './location.ts'
import type { Area } from './types.ts'
import { parseConditions, resolveAiLocation } from '../ui/ai.ts'
import { rankPlaces } from '../ui/placeSearch.ts'
import { measurePoint } from '../ui/pointCheck.ts'
import type { PointData } from '../ui/pointCheck.ts'

const representative: Area = {
  code: '1117013300', name: '서빙고동', district: '용산구', latitude: 37.52, longitude: 126.99,
  scores: { transit: 82, medical: null, safety: null },
  walking: { status: 'ok', sourceId: 'osm', checkedAt: '2026-11-21', distanceM: 147, durationSeconds: 120 },
  evidence: [], transactions: [], flags: [],
}

const calibration = { p5: 0, p95: 1 }
const empty = new Float64Array()
const gridData: PointData = {
  grid: { lat0: 37.51, lon0: 126.98, dLat: .02, dLon: .02, rows: 1, cols: 1, stepM: 50 },
  norm: { transit: calibration, medical: calibration, safety: calibration },
  meters: Uint16Array.of(647), seconds: Uint16Array.of(540), station: Uint16Array.of(0),
  stations: ['서빙고'], stationPlaces: [], snapshotId: 'test',
  pts: { bus: empty, safety: empty, cctv: empty, bell: empty, hospitals: empty, pharmacies: empty, emergency: empty, night: empty },
}

test('point inspection at the representative coordinate uses the report route and transit score', () => {
  const point = measurePoint(gridData, 37.52, 126.99, representative)
  assert.equal(point.walk?.meters, 147)
  assert.equal(point.walk?.minutes, 2)
  assert.equal(point.scores.transit, 82)
  assert.equal(measurePoint(gridData, 37.5201, 126.99, representative).walk?.meters, 647)
})

test('a missing representative route stays missing even when the surrounding grid has a route', () => {
  const area: Area = { ...representative, walking: { ...representative.walking!, status: 'no_nearby_walkway' }, scores: { ...representative.scores, transit: null } }
  const point = measurePoint(gridData, area.latitude, area.longitude, area)
  assert.equal(point.walk, null)
  assert.equal(point.scores.transit, null)
})

const station: Place = { id: 'station-강남', name: '강남역', address: '2호선', category: '지하철역', latitude: 37.49804, longitude: 127.02798 }

test('a station wins an exact name match over a venue with the same name', () => {
  const venue = { ...station, id: '0-venue-강남', category: '장소', address: '', latitude: 37.499 }
  assert.equal(rankPlaces([venue, station], '강남역')[0]?.id, station.id)
})

test('an AI response with only a radius is accepted', async () => {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => Response.json({ radiusKm: 1.5 })
  try {
    assert.equal((await parseConditions('반경만 1.5km로 바꿔 줘')).radiusKm, 1.5)
  } finally {
    globalThis.fetch = fetchBefore
  }
})

test('an unresolved AI place preserves the previous filter and reports its actual radius', () => {
  const current = { ...station, radiusKm: 3 }
  const next = resolveAiLocation({ place: '찾을 수 없는 장소', radiusKm: 1 }, current, 3)
  assert.equal(next.filter, current)
  assert.match(next.warning, /강남역.*3\s*km/)
})

test('a radius-only AI request updates the existing location or explains why it cannot apply', () => {
  const current = { ...station, radiusKm: 3 }
  assert.deepEqual(resolveAiLocation({ radiusKm: 1.5 }, current, 3).filter, { ...current, radiusKm: 1.5 })
  const withoutPlace = resolveAiLocation({ radiusKm: 1.5 }, undefined, 3)
  assert.equal(withoutPlace.filter, undefined)
  assert.match(withoutPlace.warning, /기준 위치/)
})

test('an out-of-range radius-only AI request explains the allowed range', async () => {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => Response.json({ radiusKm: 25 })
  try {
    await assert.rejects(parseConditions('반경만 25km로 바꿔 줘'), /반경은 0\.5~20km로 설정해 주세요/)
  } finally {
    globalThis.fetch = fetchBefore
  }
})

test('an invalid radius prevents a new station request from being partially applied', async () => {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => Response.json({ place: '신림역', radiusKm: 25 })
  try {
    await assert.rejects(parseConditions('신림역으로 바꾸고 반경은 25km로 해 줘'), /반경은 0\.5~20km로 설정해 주세요/)
  } finally {
    globalThis.fetch = fetchBefore
  }
})

test('AI radius validation accepts both limits and rejects values below the minimum before rounding', async () => {
  const fetchBefore = globalThis.fetch
  let radiusKm = .5
  globalThis.fetch = async () => Response.json({ place: '신림역', radiusKm })
  try {
    assert.equal((await parseConditions('신림역 반경 0.5km')).radiusKm, .5)
    radiusKm = 20
    assert.equal((await parseConditions('신림역 반경 20km')).radiusKm, 20)
    radiusKm = .49
    await assert.rejects(parseConditions('신림역 반경 0.49km'), /반경은 0\.5~20km로 설정해 주세요/)
  } finally {
    globalThis.fetch = fetchBefore
  }
})
