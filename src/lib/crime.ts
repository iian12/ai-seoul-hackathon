import type { Snapshot } from './types.ts'
export interface DistrictCrime { district: string; year: number; cases: number; population: number; per100k: number }
/** Rank only the 25 independent district observations, never 467 duplicated dong values. */
export function applyPolicingScores(snapshot: Snapshot): void {
  const byDistrict = new Map<string, DistrictCrime>()
  for (const area of snapshot.areas) if (area.crime) {
    validateCrime(area.crime, area.district)
    const old = byDistrict.get(area.district)
    if (old && JSON.stringify(old) !== JSON.stringify(area.crime)) throw new Error('같은 구의 치안 통계 불일치')
    byDistrict.set(area.district, area.crime)
  }
  if (byDistrict.size !== 25) throw new Error('치안 점수는 서울 25개 구 전체 통계가 필요합니다.')
  const rates = [...byDistrict.values()].map(c => c.per100k).sort((a,b) => a-b)
  for (const area of snapshot.areas) {
    if (!area.crime) { area.scores.policing = null; continue }
    const value = area.crime.per100k, first = rates.indexOf(value), last = rates.lastIndexOf(value)
    area.scores.policing = rates[0] === rates.at(-1) ? 50 : 100 * (1 - (first + last) / 2 / (rates.length - 1))
    for (const e of area.evidence) if (e.sourceId === 'crime') e.value = e.value.replace('추천 점수에는 미합산', '치안 점수에만 반영')
  }
  snapshot.calculation = { ...snapshot.calculation, policing: { method: '25개 자치구의 전체 범죄 발생률 역백분위 · 동률 평균 순위 · 낮을수록 높은 점수', year: 2025, districtCount: 25, rankWeight: '사용자 치안 중요도', independentFromSafetyFacilities: true } }
  snapshot.warnings = snapshot.warnings.map(w => w.startsWith('범죄 발생률은') ? w.replace('추천 점수에는 합산하지 않습니다', '치안 항목에만 반영하며 안전시설 점수에는 반영하지 않습니다') : w)
  snapshot.modelVersion = 'seoul-five-domain-4.0'
}
export function validateCrime(c: DistrictCrime, district: string) {
  if (!c || c.district !== district || !Number.isInteger(c.year) || c.year < 2000 || !Number.isSafeInteger(c.cases) || c.cases < 0 || !Number.isSafeInteger(c.population) || c.population <= 0 || !Number.isFinite(c.per100k) || Math.abs(c.per100k - c.cases / c.population * 100000) > 1e-8) throw new Error('자치구 범죄율의 지역·연도·건수·인구를 확인해 주세요.')
}
export function attachCrime(snapshot: Snapshot, data: { year: number; crimeSource: string; populationSource: string; districts: DistrictCrime[] }, retrievedAt: string) {
  const byDistrict = new Map(data.districts.map(c => [c.district, c]))
  if (byDistrict.size !== 25 || data.districts.length !== 25) throw new Error('범죄 통계 25개 자치구 누락·중복')
  for (const area of snapshot.areas) {
    const c = byDistrict.get(area.district)!
    validateCrime(c, area.district)
    if (c.year !== data.year) throw new Error('범죄·인구 기준연도 불일치')
    area.crime = { ...c }
    area.evidence = area.evidence.filter(e => !['crime', 'crime-population'].includes(e.sourceId))
    area.evidence.push({ label: '자치구 전체 범죄 발생률', value: `${c.year}년 ${c.district}: 주민등록인구 10만 명당 ${c.per100k.toFixed(1)}건 (${c.cases.toLocaleString('ko-KR')}건 / ${c.population.toLocaleString('ko-KR')}명). 교통범죄 등 포함. 동별 수치·개인 피해 확률이 아니며 추천 점수에는 미합산.`, sourceId: 'crime' })
    area.evidence.push({ label: '범죄율 인구 기준', value: `${c.year}년 12월 31일 주민등록인구(내국인). 연평균·생활인구와 다름.`, sourceId: 'crime-population' })
  }
  snapshot.sources = snapshot.sources.filter(s => !['crime', 'crime-population'].includes(s.id))
  snapshot.sources.push({ id: 'crime', name: `${data.year}년 경찰청 범죄 발생 지역별 통계`, provider: '경찰청', url: data.crimeSource, license: '이용허락범위 제한 없음', observedDate: `${data.year}-12-31`, retrievedAt }, { id: 'crime-population', name: `${data.year}년 4분기 서울 등록인구 · 주민등록인구 열`, provider: '서울특별시·행정안전부', url: data.populationSource, license: '서울시 공식 통계 · 출처표시', observedDate: `${data.year}-12-31`, retrievedAt })
  snapshot.warnings = snapshot.warnings.filter(w => !w.startsWith('범죄 발생률은'))
  snapshot.warnings.push('범죄 발생률은 자치구 전체의 연간 전체범죄(교통범죄 등 포함)를 연말 주민등록인구로 나눈 참고 통계입니다. 같은 구의 동네에는 동일한 값이 표시되며 동별 위험·개인 피해 확률이 아닙니다. 유동인구를 반영하지 않으며 추천 점수에는 합산하지 않습니다.')
  return snapshot
}
