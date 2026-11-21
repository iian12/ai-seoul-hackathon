import type { Snapshot, WalkingRoute } from './types.ts'
import { calibrateScores, scoreMetric } from './score-normalization.ts'

export interface WalkingData { report: { extract: { url: string; lastModified: string; downloadedAt: string }; [key: string]: unknown }; areas: Record<string, WalkingRoute> }

export function attachWalking(snapshot: Snapshot, data: WalkingData): Snapshot {
  const next = structuredClone(snapshot)
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(data.report.extract.lastModified))
  const raws: { code: string; raw: number }[] = []
  for (const area of next.areas) {
    const route = data.areas[area.code]
    if (!route?.origin || Math.abs(route.origin.latitude - area.latitude) > 1e-7 || Math.abs(route.origin.longitude - area.longitude) > 1e-7) throw new Error('도보 캐시와 지역 대표점이 일치하지 않습니다. 경로를 다시 집계해 주세요.')
    area.walking = route
    area.evidence = area.evidence.filter(e => !['대중교통 접근성', '역 도보 접근성'].includes(e.label))
    if (route.status === 'ok') {
      const bus = area.metrics?.busDistanceM
      if (!Number.isFinite(bus) || !Number.isFinite(route.distanceM) || !Number.isFinite(route.durationSeconds)) throw new Error('보행·정류소 지표 누락')
      const raw = .6 * Math.exp(-route.distanceM! / 500) + .4 * Math.exp(-bus! / 300)
      raws.push({ code: area.code, raw })
      area.metrics = { ...area.metrics, stationWalkingDistanceM: route.distanceM!, stationWalkingSeconds: route.durationSeconds!, transitRaw: raw }
      area.evidence.unshift({ label: '역 도보 접근성', value: `입구 인근 보행로까지 약 ${(route.durationSeconds! / 60).toFixed(1)}분 · ${Math.round(route.distanceM!)}m (도로망 최단거리). 시작점 보정 ${Math.round(route.originSnapM!)}m · 도착점 보정 ${Math.round(route.destinationSnapM ?? 0)}m는 미포함. 버스정류소는 직선 ${Math.round(bus!)}m.`, sourceId: 'walking-osm' })
    } else {
      area.scores.transit = null
      area.evidence.unshift({ label: '역 도보 접근성', value: route.status === 'no_nearby_walkway' ? '대표점 100m 내 보행로를 확인하지 못해 추천에서 제외합니다.' : '연결된 지하철 출입구 경로를 확인하지 못해 추천에서 제외합니다.', sourceId: 'walking-osm' })
    }
  }
  if (!raws.length) throw new Error('정상 도보 경로가 없습니다. 기존 정상 스냅샷을 유지합니다.')
  const calibration = calibrateScores(raws.map(r => r.raw))
  const scores = new Map(raws.map(r => [r.code, scoreMetric(r.raw, calibration)]))
  for (const area of next.areas) if (scores.has(area.code)) area.scores.transit = scores.get(area.code)!
  next.sources = next.sources.filter(s => s.id !== 'walking-osm')
  next.sources.push({ id: 'walking-osm', name: 'OSM 보행 네트워크·지하철 출입구 (BBBike 서울 추출본)', provider: 'OpenStreetMap contributors / BBBike', url: 'https://download.bbbike.org/osm/bbbike/Seoul/', license: 'ODbL 1.0 · 출처 표시. 경로는 로컬 계산, 운영 상태·휠체어 접근성 미검증', observedDate: date, retrievedAt: data.report.extract.downloadedAt })
  next.modelVersion = ['seoul-percentile-3.0', 'seoul-five-domain-4.0'].includes(snapshot.modelVersion) ? snapshot.modelVersion : 'seoul-walking-1.0'
  next.id = `${next.id.replace(/-walking$/, '')}-walking`
  next.calculation = { ...next.calculation, transit: '60% exp(-stationWalkingDistanceM/500) + 40% exp(-busStraightDistanceM/300), percentile-v1 normalization over confirmed walking routes', transitNormalization: calibration, normalization: { ...(next.calculation?.normalization as Record<string, unknown>), transit: calibration }, walking: data.report }
  next.warnings = next.warnings.filter(w => !w.startsWith('법정동 대표점 직선거리 기준') && !w.startsWith('역 접근성은'))
  next.warnings.push('역 접근성은 대표점 인근 보행로에서 지하철 출입구 인근 보행로까지의 도로망 최단거리입니다. 시작·도착점 보정은 별도이며 도보 거리에 합산하지 않습니다. 시간은 일반 길 4.5km/h, 계단 0.8m/s 추정이며 실시간 통제·신호대기·휠체어 접근성을 보장하지 않습니다.')
  return next
}
