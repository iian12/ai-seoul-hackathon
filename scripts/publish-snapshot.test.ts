import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { demoSnapshot } from '../src/lib/demo.ts'
import { publishSnapshot, readPublishedSnapshot } from './publish-snapshot.mjs'

test('publication switches a complete release only after verification; failed verification preserves it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seoul-publish-'))
  try {
    const snapshot = structuredClone(demoSnapshot)
    snapshot.calculation = { normalization: { safety: { p5: 0, p95: 1 }, transit: { p5: 0, p95: 1 }, medical: { p5: 0, p95: 1 } } }
    const points = { snapshotId: snapshot.id, normalization: snapshot.calculation.normalization, walkGrid: { rows: 1, cols: 1, lat0: 37.5, lon0: 127, dLat: .001, dLon: .001, stepM: 50 }, stations: ['테스트역'], points: {} }
    const walkFile = join(root, 'walk.bin'); const binary = Buffer.alloc(6); binary.writeUInt16LE(100, 0); binary.writeUInt16LE(80, 2); await writeFile(walkFile, binary)
    let checked = false
    const manifest = await publishSnapshot(snapshot, { root, points, walkFile, verify: async path => {
      assert.ok(JSON.parse(await readFile(path, 'utf8')).id.startsWith(snapshot.id + '-release-'))
      await assert.rejects(readFile(join(root, 'current.json')))
      checked = true
    } })
    assert.ok(checked)
    assert.deepEqual(await readPublishedSnapshot(root), { ...snapshot, id: manifest.id })
    const path = join(root, manifest.gzip.replace('/data/', ''))
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(path)).toString()), { ...snapshot, id: manifest.id })
    const before = await readFile(join(root, 'current.json'), 'utf8')
    for (const invalid of [Buffer.alloc(6), Buffer.from([100, 0, 80, 0, 99, 0]), Buffer.from([100, 0, 1, 0, 0, 0])]) {
      await writeFile(walkFile, invalid)
      await assert.rejects(publishSnapshot(snapshot, { root, points, walkFile, verify: async () => {} }), /보행/)
      assert.equal(await readFile(join(root, 'current.json'), 'utf8'), before)
    }
    await writeFile(walkFile, binary)
    const next = { ...snapshot, id: 'next' }
    await assert.rejects(publishSnapshot(next, { root, points: { ...points, snapshotId: 'next' }, walkFile, verify: async () => { throw new Error('SQL mismatch') } }), /SQL mismatch/)
    assert.equal(await readFile(join(root, 'current.json'), 'utf8'), before)
    assert.equal(JSON.parse(await readFile(join(root, 'seoul-snapshot.json'), 'utf8')).id, manifest.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unrelated enrichment left by a failed build cannot enter a published snapshot', async () => {
  const { preparePointData } = await import('./point-enrichment.mjs')
  const root = await mkdtemp(join(tmpdir(), 'seoul-facility-version-'))
  try {
    const snapshot = structuredClone(demoSnapshot)
    snapshot.calculation = { normalization: { safety: {}, transit: {}, medical: {} }, transitNormalization: {} }
    const pointPath = join(root, 'point.json'), extraPath = join(root, 'extra.json'), manifestPath = join(root, 'manifest.json')
    await writeFile(pointPath, JSON.stringify({ points: {}, normalization: {} }))
    await writeFile(extraPath, JSON.stringify({ snapshotId: 'failed-build', points: {} }))
    await writeFile(manifestPath, JSON.stringify({ sources: [] }))
    await assert.rejects(preparePointData(snapshot, pointPath, extraPath, manifestPath), /원천 버전 불일치/)
    await writeFile(extraPath, JSON.stringify({ snapshotId: snapshot.id, points: {} }))
    const point = await preparePointData(snapshot, pointPath, extraPath, manifestPath)
    assert.equal(snapshot.calculation.facilitySnapshotId, snapshot.id)
    assert.equal(point.snapshotId, snapshot.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})
