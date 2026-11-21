import test from 'node:test'
import assert from 'node:assert/strict'
import { createExplanation, validateExplanation } from './explanation.ts'
const recs = [{ rank: 1, name: '사당동', district: '동작구', total: 70, scores: { transit: 90 }, matchCount: 10, sampleCount: 100, matchPct: 10, medianRentManwon: 50 }]
const valid = { summary: '사당동은 예산에 맞는 계약이 10건이에요.', areas: [{ rank: 1, headline: '계약 비율 확인', pros: ['교통 상대 점수는 90점이에요.'], cons: ['예산에 맞는 계약 비율은 10%예요.'] }], tip: '계약 조건을 확인하세요.' }

test('explanation accepts grounded content and rejects wrong ranks, numbers, regions, unsafe claims and malformed fields', () => {
  assert.ok(validateExplanation(valid, recs))
  for (const invalid of [
    { ...valid, areas: [{ ...valid.areas[0], rank: 2 }] },
    { ...valid, areas: [{ ...valid.areas[0], pros: ['교통 점수는 99점이에요.'] }] },
    { ...valid, areas: [{ ...valid.areas[0], pros: ['교통 점수는 70점이에요.'] }] },
    { ...valid, summary: '신림동은 좋아요.' },
    { ...valid, areas: [{ ...valid.areas[0], headline: '안전시설 최고' }] },
    { ...valid, summary: '범죄가 적은 안전한 동네예요.' },
    { ...valid, areas: [{ ...valid.areas[0], pros: null }] },
    { ...valid, areas: [] },
  ]) assert.equal(validateExplanation(invalid, recs), false)
})

test('provider errors and invalid explanations return an explicitly labelled factual fallback', async () => {
  for (const generate of [async () => { throw new Error('upstream') }, async () => ({ ...valid, summary: '안전한 동네예요.' })]) {
    const result = await createExplanation(recs, generate)
    assert.equal(result.source, 'fallback')
    assert.equal(result.areas.length, 1)
    assert.ok(result.areas[0].cons.some(s => s.includes('10%')))
    assert.ok(validateExplanation(result, recs))
  }
  assert.equal((await createExplanation(recs, async () => valid)).source, 'ai')
})

test('score numbers cannot be reused as rent, percentages, facility counts or walking times', () => {
  for (const summary of ['예산에 맞는 계약은 100건이에요.', '전체 계약은 10건이에요.', '월세 중간값은 70만 원이에요.', '계약 비율은 70%예요.', '병원이 70곳이에요.', '역까지 70분이에요.', '이 지역은 안전합니다.', '사당동은 범죄율이 낮아요.']) {
    assert.equal(validateExplanation({ ...valid, summary }, recs), false, summary)
  }
})

test('rent claims preserve the meaning of currency units and signs', () => {
  assert.equal(validateExplanation({ ...valid, summary: '월세 중간값은 500,000원이에요.' }, recs), true)
  assert.equal(validateExplanation({ ...valid, summary: '월세 중간값은 -50만 원이에요.' }, recs), false)
})
