import test from 'node:test'
import assert from 'node:assert/strict'
import { loadLocalSnapshot } from './load-local-snapshot.ts'
import { demoSnapshot } from './demo.ts'

test('corrupt gzip falls back to valid JSON from the same release', async () => {
  const calls: string[] = []
  const previous = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (url.endsWith('current.json')) return new Response('', { status: 404 })
    if (url.endsWith('.gz')) return new Response('broken gzip')
    return Response.json(demoSnapshot)
  }
  try {
    assert.deepEqual(await loadLocalSnapshot(), demoSnapshot)
    assert.ok(calls.includes('/data/seoul-snapshot.json'))
  } finally { globalThis.fetch = previous }
})

test('invalid gzip snapshot falls back, and both failures remain errors', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async input => String(input).endsWith('current.json') ? new Response('', { status: 404 }) : new Response('invalid')
  try { await assert.rejects(loadLocalSnapshot()) } finally { globalThis.fetch = previous }
})

test('network failure or invalid gzip content uses the pinned release JSON even if the pointer changes', async () => {
  const previous = globalThis.fetch
  const base = '/data/releases/test-v1/'
  const manifest = { version: 1, id: demoSnapshot.id, snapshot: base + 'seoul-snapshot.json', gzip: base + 'seoul-snapshot.json.gz', points: base + 'point-facilities.json', walk: base + 'point-walk.bin' }
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (url.endsWith('current.json')) return Response.json(manifest)
    if (url.endsWith('.gz')) throw new TypeError('network failed')
    assert.equal(url, manifest.snapshot)
    return Response.json(demoSnapshot)
  }
  try {
    assert.deepEqual(await loadLocalSnapshot(), demoSnapshot)
    assert.equal(calls.filter(s => s.endsWith('current.json')).length, 1)
  } finally { globalThis.fetch = previous }
})

test('a valid gzip containing an invalid snapshot falls back to validated JSON', async () => {
  const { gzipSync } = await import('node:zlib')
  const previous = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.endsWith('current.json')) return new Response('', { status: 404 })
    if (url.endsWith('.gz')) return new Response(gzipSync(JSON.stringify({ id: 'bad' })))
    return Response.json(demoSnapshot)
  }
  try { assert.deepEqual(await loadLocalSnapshot(), demoSnapshot) } finally { globalThis.fetch = previous }
})
