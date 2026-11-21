import test from 'node:test'
import assert from 'node:assert/strict'
import { rentalWindowStart, validDate } from './rental-window.ts'
import { isValidTransaction } from './recommend.ts'
import { demoSnapshot } from './demo.ts'

test('internal rental window follows the last source contract date and clamps leap days', () => {
  assert.equal(rentalWindowStart('2026-11-13'), '2024-11-13')
  assert.equal(rentalWindowStart('2024-02-29'), '2022-02-28')
  assert.equal(rentalWindowStart('2026-11-13', 12), '2025-11-13')
  assert.throws(() => rentalWindowStart('2026-02-30'))
})
test('impossible calendar dates and contracts outside the published period are excluded', () => {
  assert.equal(validDate('2026-02-30'), false)
  const t = { ...demoSnapshot.areas[0].transactions[0], contractDate: '2026-02-30' }
  assert.equal(isValidTransaction(t, demoSnapshot), false)
  assert.equal(isValidTransaction({ ...t, contractDate: '2025-01-01' }, demoSnapshot), false)
})
