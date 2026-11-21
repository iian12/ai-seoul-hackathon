import type { Area, Snapshot } from './types.ts'

// Synthetic fixtures for interaction and algorithm QA. None are measured Seoul statistics.
const definitions = [
  ['demo-01', '공릉1동', '노원구', 37.6248, 127.0738, 84, 79, 86, 500, 44],
  ['demo-02', '청룡동', '관악구', 37.4794, 126.9416, 72, 94, 78, 700, 48],
  ['demo-03', '화곡1동', '강서구', 37.5304, 126.8415, 79, 76, 88, 500, 42],
  ['demo-04', '망원1동', '마포구', 37.5556, 126.9056, 89, 86, 83, 1000, 60],
  ['demo-05', '성수1가1동', '성동구', 37.5421, 127.0497, 87, 91, 75, 1500, 74],
  ['demo-06', '회기동', '동대문구', 37.5908, 127.0553, 77, 90, 95, 800, 52],
  ['demo-07', '대조동', '은평구', 37.6141, 126.9206, 91, 88, 73, 600, 45],
  ['demo-08', '문래동', '영등포구', 37.5171, 126.8994, null, 89, 86, 1000, 56],
  ['demo-09', '잠실본동', '송파구', 37.5062, 127.0831, 88, 92, 90, 1000, 61],
] as const

const areas: Area[] = definitions.map(([code, name, district, latitude, longitude, safety, transit, medical, deposit, rent], index) => ({
  code, name, district, latitude, longitude,
  scores: { safety, transit, medical },
  jeonseGroups: Array.from({ length: 4 }, (_, i) => ({ depositKrw: (12000 + index * 2000 + i * 3000) * 10000, count: index === 8 ? 2 : 8 })),
  flags: safety === null ? ['안전 인프라 지표 미집계 · 추천 제외'] : [],
  evidence: [
    { label: '안전 인프라', value: safety === null ? '미집계' : `가상 사전 점수 ${safety}점`, sourceId: 'safety-demo' },
    { label: '대중교통 접근성', value: `가상 사전 점수 ${transit}점`, sourceId: 'transit-demo' },
    { label: '의료 접근성', value: `가상 사전 점수 ${medical}점`, sourceId: 'medical-demo' },
  ],
  transactions: Array.from({ length: index === 8 ? 9 : 32 }, (_, i) => ({
    id: `${code}-${i}`, depositKrw: (deposit + (i % 4) * 100) * 10000,
    monthlyRentKrw: (rent + (i % 7) * 3) * 10000,
    areaM2: 18 + i % 15, contractDate: `2026-${String(1 + i % 10).padStart(2, '0')}-15`, housingType: '연립·다세대', leaseType: 'monthly' as const,
  })),
}))

export const demoSnapshot: Snapshot = {
  id: 'demo-seoul-2026-11-14', modelVersion: 'mvp-1.0', isDemo: true, spatialUnit: '행정동 이름을 사용한 가상 지역',
  createdAt: '2026-11-14T09:00:00+09:00', periodStart: '2025-11-01', periodEnd: '2026-10-31', areas,
  warnings: ['체험 데이터입니다. 점수·거래 표본은 모두 가상 값이며 실제 동네의 생활환경을 평가하지 않습니다.'],
  sources: [
    { id: 'safety-demo', name: '안심귀갓길 경로 · 연동 예정', provider: '서울특별시', url: 'https://data.seoul.go.kr/dataList/OA-21695/S/1/datasetView.do', license: '가상 값 · 링크는 원천 후보', observedDate: '2026-11-14', retrievedAt: '2026-11-14' },
    { id: 'transit-demo', name: '역사마스터 정보 · 연동 예정', provider: '서울특별시', url: 'https://data.seoul.go.kr/dataList/OA-21232/A/1/datasetView.do', license: '가상 값 · 링크는 원천 후보', observedDate: '2026-11-14', retrievedAt: '2026-11-14' },
    { id: 'rent-demo', name: '부동산 전월세가 정보 · 연동 예정', provider: '서울특별시', url: 'https://data.seoul.go.kr/dataList/OA-21276/S/1/datasetView.do', license: '가상 값 · 링크는 원천 후보', observedDate: '2026-11-14', retrievedAt: '2026-11-14' },
    { id: 'medical-demo', name: '병원정보서비스 · 연동 예정', provider: '건강보험심사평가원', url: 'https://www.data.go.kr/data/15001698/openapi.do', license: '가상 값 · 링크는 원천 후보', observedDate: '2026-11-14', retrievedAt: '2026-11-14' },
  ],
}
