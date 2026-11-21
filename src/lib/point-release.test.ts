import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPointData } from '../ui/pointCheck.ts'

test('point inspection pins facilities and walking binary to the selected release and rejects other snapshots', async () => {
  const previous = globalThis.fetch, calls: string[] = []
  const base = '/data/releases/test-point/'
  const manifest = { version: 1, id: 'test-point', snapshot: base + 'seoul-snapshot.json', gzip: base + 'seoul-snapshot.json.gz', points: base + 'point-facilities.json', walk: base + 'point-walk.bin' }
  const point = { snapshotId: 'test-point', normalization: {}, walkGrid: { rows: 1, cols: 1, file: 'ignored.bin' }, points: {}, stations: [], stationPoints: [] }
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (url.endsWith('current.json')) return Response.json(manifest)
    if (url === manifest.points) return Response.json(point)
    if (url === manifest.walk) return new Response(new Uint8Array(6))
    throw new Error('unexpected URL')
  }
  try {
    assert.equal((await loadPointData('test-point')).snapshotId, 'test-point')
    assert.ok(calls.includes(manifest.walk))
    await assert.rejects(loadPointData('old-snapshot'), /갱신/)
  } finally { globalThis.fetch = previous }
})
