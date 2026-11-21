import test from 'node:test'
import assert from 'node:assert/strict'
import { collectPages, decodePage, requestJson } from './api.mjs'
import { normalizeFacilities } from './spatial.ts'
test('short, repeated and changing pages cannot masquerade as complete sources', async () => {
  await assert.rejects(() => collectPages(async () => ({ rows: [{ a: 1 }], total: 3 }), 2))
  await assert.rejects(() => collectPages(async () => ({ rows: [{ a: 1 }], total: 2 }), 1))
  await assert.rejects(() => collectPages(async (p: number) => ({ rows: [{ a: p }], total: p === 1 ? 2 : 3 }), 1))
})
test('NMC/MOIS nested pagination and single XML item are decoded', () => {
  assert.deepEqual(decodePage({ response: { header: { resultCode: '00' }, body: { totalCount: '1', items: { item: { hpid: 'a' } } } } }), { total: 1, rows: [{ hpid: 'a' }] })
  assert.throws(() => decodePage({ response: { header: { resultCode: '30' } } }))
})
test('secret-echo and unauthorized responses are not persisted as data', async () => {
  await assert.rejects(() => requestJson('https://example.test', ['private-key'], async () => new Response('private-key')))
  await assert.rejects(() => requestJson('https://example.test', [], async () => new Response('{}', { status: 403 })))
})
test('CCTV purpose and missing coordinates are explicit and no camera count is invented', () => {
  const r = normalizeFacilities([{ LAT: '37.5665', LOT: '126.978', INSTL_PRPS: '방범', SN: 'a' }, { LAT: '37.5665', LOT: '126.978', INSTL_PRPS: '교통단속', SN: 'b' }, { LAT: '', LOT: '', INSTL_PRPS: '방범', SN: 'c' }], 'cctv')
  assert.equal(r.points.length, 1); assert.equal(r.qa.invalid, 1); assert.equal(r.points[0].count, undefined)
})
