import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileMedical } from './reconcile-medical.ts'
const h = {ykiho:'id', yadmNm:'우리 의원',telno:'02-1234-5678',addr:'서울특별시 종로구 테스트',YPos:37.57,XPos:126.98}
const n = {dutyName:'우리의원',dutyTel1:'0212345678',dutyAddr:'서울특별시 종로구 테스트',wgs84Lat:37.5701,wgs84Lon:126.98}
test('coordinates reconcile only unique institutions in same district within 100m', () => {
  const r=reconcileMedical([h],[n]); assert.equal(r.points.length,1);assert.equal(r.points[0].latitude,37.5701)
  for(const rows of [[n,n],[{...n,dutyAddr:'서울특별시 강남구 테스트'}],[{...n,wgs84Lat:37.6}],[{...n,dutyTel1:'0299999999'}]]) {
    assert.equal(reconcileMedical([h],rows).points[0].latitude,h.YPos)
  }
  const repaired=reconcileMedical([{...h,YPos:0,XPos:0}],[n]);assert.equal(repaired.qa.repairedCoordinates,1)
})
