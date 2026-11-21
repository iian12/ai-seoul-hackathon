import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Crosshair, LoaderCircle, Search, TrainFront, X } from 'lucide-react'
import { rankPlaces } from '../ui/placeSearch.ts'
import { STATIONS } from '../ui/stations.ts'
import { areaAt, distanceFrom, loadPointData, measurePoint } from '../ui/pointCheck.ts'
import type { PointData, PointMetrics } from '../ui/pointCheck.ts'
import { walkMinutes } from '../ui/plain.ts'
import { domainLabels } from './ScoreBars'
import type { Place } from '../lib/location.ts'
import type { Area } from '../lib/types.ts'

export interface CheckedPoint { latitude: number; longitude: number; name: string }
interface Props { snapshotId: string; areas: Area[]; point: CheckedPoint | null; backLabel: string; onPoint: (p: CheckedPoint) => void; onClear: () => void; onBack: () => void; onOpenArea: (code: string) => void }
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: PointData }

const withYeok = (n: string) => n.endsWith('역') ? n : `${n}역`
const round10 = (m: number) => Math.round(m / 10) * 10
const dist = (m: number) => !Number.isFinite(m) ? '-' : m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${round10(m)}m`

interface Row { label: string; here: string; rep: string; diff: string; tone: 'better' | 'worse' | 'same' | 'none' }
/** 높을수록 좋은 값(점수·개수)과 낮을수록 좋은 값(거리·시간)의 차이를 말로 적는다 */
function diffOf(here: number | null | undefined, rep: number | null | undefined, unit: string, lowerIsBetter: boolean, minStep: number): Pick<Row, 'diff' | 'tone'> {
  if (here == null || rep == null || !Number.isFinite(here) || !Number.isFinite(rep)) return { diff: '비교 불가', tone: 'none' }
  const d = here - rep
  if (Math.abs(d) < minStep) return { diff: '비슷해요', tone: 'same' }
  const better = lowerIsBetter ? d < 0 : d > 0
  const size = unit === 'm' ? dist(Math.abs(d)) : `${Math.round(Math.abs(d))}${unit}`
  const word = lowerIsBetter ? (d < 0 ? '짧아요' : '길어요') : (d > 0 ? '많아요' : '적어요')
  return { diff: unit === '점' ? `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))}점` : `${size} ${word}`, tone: better ? 'better' : 'worse' }
}

function rowsFor(m: PointMetrics, area: Area): Row[] {
  const a = area.metrics ?? {}
  const repMin = walkMinutes(area)
  const s = area.scores
  const score = (k: 'safety' | 'transit' | 'medical'): Row => ({ label: `${domainLabels[k]} 점수`, here: m.scores[k] == null ? '-' : `${Math.round(m.scores[k]!)}점`, rep: s[k] == null ? '-' : `${Math.round(s[k]!)}점`, ...diffOf(m.scores[k], s[k], '점', false, 3) })
  return [
    { label: '역까지 걷는 시간', here: m.walk ? `약 ${m.walk.minutes}분` : '경로 없음', rep: repMin != null ? `약 ${repMin}분` : '경로 없음', ...diffOf(m.walk?.minutes, repMin, '분', true, 1) },
    { label: '역까지 걷는 거리', here: m.walk ? dist(m.walk.meters) : '-', rep: area.walking?.status === 'ok' ? dist(area.walking.distanceM ?? NaN) : '-', ...diffOf(m.walk?.meters, area.walking?.status === 'ok' ? area.walking.distanceM : null, 'm', true, 30) },
    { label: '버스정류장 (직선)', here: dist(m.busM), rep: dist(a.busDistanceM ?? NaN), ...diffOf(m.busM, a.busDistanceM, 'm', true, 30) },
    score('transit'),
    { label: '500m 안 안전시설 (안심귀갓길)', here: `${m.safety500}곳`, rep: a.observedSafety500m != null ? `${a.observedSafety500m}곳` : '-', ...diffOf(m.safety500, a.observedSafety500m, '곳', false, 1) },
    { label: a.cctv500m != null ? '공공 방범 CCTV' : '그중 CCTV', here: `${m.cctv500}곳`, rep: (a.cctv500m ?? a.observedCctv500m) != null ? `${a.cctv500m ?? a.observedCctv500m}곳` : '-', ...diffOf(m.cctv500, a.cctv500m ?? a.observedCctv500m, '곳', false, 1) },
    score('safety'),
    { label: '500m 안 병·의원', here: `${m.hospitals500}곳`, rep: a.hospitals500m != null ? `${a.hospitals500m}곳` : '-', ...diffOf(m.hospitals500, a.hospitals500m, '곳', false, 1) },
    { label: '500m 안 약국', here: `${m.pharmacies500}곳`, rep: a.pharmacies500m != null ? `${a.pharmacies500m}곳` : '-', ...diffOf(m.pharmacies500, a.pharmacies500m, '곳', false, 1) },
    { label: '1km 안 야간시간 공시 약국', here: `${m.night1000}곳`, rep: a.nightPharmacies1000m != null ? `${a.nightPharmacies1000m}곳` : '-', ...diffOf(m.night1000, a.nightPharmacies1000m, '곳', false, 1) },
    score('medical'),
  ]
}

/** 한 줄 요약: 대표점보다 나은 것과 아쉬운 것을 짧게 */
function summaryOf(m: PointMetrics, area: Area) {
  const repMin = walkMinutes(area)
  const parts: string[] = []
  if (m.walk && repMin != null && m.walk.minutes !== repMin) parts.push(`역까지 ${Math.abs(m.walk.minutes - repMin)}분 ${m.walk.minutes < repMin ? '덜' : '더'} 걸어요`)
  else if (m.walk && repMin != null) parts.push('역까지 걷는 시간은 대표점과 같아요')
  for (const k of ['safety', 'medical'] as const) {
    const r = area.scores[k]
    if (r == null) continue
    const d = m.scores[k] - r
    if (Math.abs(d) >= 10) parts.push(`${domainLabels[k]} 점수가 ${Math.abs(Math.round(d))}점 ${d > 0 ? '높아요' : '낮아요'}`)
  }
  return parts.length ? `동 대표점과 비교하면 ${parts.join(', ')}.` : '동 대표점과 큰 차이는 없어요.'
}

export default function PointCheck({ snapshotId, areas, point, backLabel, onPoint, onClear, onBack, onOpenArea }: Props) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [places, setPlaces] = useState<Place[]>([])
  const placesAsked = useRef(false)
  const id = useId()
  const deferred = useDeferredValue(query)

  useEffect(() => {
    let live = true
    loadPointData(snapshotId).then(data => { if (live) setLoad({ status: 'ready', data }) }).catch((e: Error) => { if (live) setLoad({ status: 'error', message: e.message }) })
    window.setTimeout(() => document.getElementById('point-title')?.focus({ preventScroll: true }), 30)
    return () => { live = false }
  }, [snapshotId])

  // 키보드로도 위치를 정할 수 있게: 동 대표점·역·학교·회사 이름으로 찾기
  function askPlaces() {
    if (placesAsked.current) return
    placesAsked.current = true
    fetch('/data/seoul-places.json').then(r => r.ok ? r.json() : null).then(d => { if (Array.isArray(d?.places)) setPlaces(d.places) }).catch(() => {})
  }
  const index = useMemo<Place[]>(() => [
    ...(load.status === 'ready' ? load.data.stationPlaces.map(s => ({ id: `st-${s.name}`, name: withYeok(s.name), address: s.lines, category: '지하철역', latitude: s.latitude, longitude: s.longitude }))
      : STATIONS.map(s => ({ id: `st-${s.name}`, name: `${s.name}역`, address: s.lines.join(' · '), category: '지하철역', latitude: s.lat, longitude: s.lng }))),
    ...areas.map(a => ({ id: a.code, name: `${a.district} ${a.name}`, address: '동네 대표점', category: '동네', latitude: a.latitude, longitude: a.longitude })),
    ...places,
  ], [areas, places, load])
  const matches = useMemo(() => {
    const q = deferred.replace(/\s+/g, '')
    const stations = q.length >= 2 ? index.filter(p => p.category === '지하철역' && p.name.startsWith(q.endsWith('역') ? q : `${q}`)).slice(0, 3) : []
    const rest = rankPlaces(index.filter(p => p.category !== '지하철역'), deferred, 10)
    return [...stations, ...rest]
  }, [index, deferred])
  const listOpen = open && query.trim().length >= 2
  function choose(p: Place) { onPoint({ latitude: p.latitude, longitude: p.longitude, name: p.name }); setQuery(''); setOpen(false); setActive(0) }

  const area = point ? areaAt(areas, point.latitude, point.longitude) : null
  const atRepresentative = !!(point && area && point.latitude === area.latitude && point.longitude === area.longitude)
  const metrics = point && load.status === 'ready' ? measurePoint(load.data, point.latitude, point.longitude, area) : null
  const rows = metrics && area ? rowsFor(metrics, area) : null

  return <article className="report point-check" aria-labelledby="point-title">
    <button type="button" className="btn btn-ghost btn-sm back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />{backLabel}</button>
    <header className="point-head">
      <h2 id="point-title" tabIndex={-1}><Crosshair size={18} aria-hidden="true" />위치 찍어 보기</h2>
      <p>점수는 동마다 한 점(대표점)에서 계산해요. 지도에서 집 후보 자리를 누르면 그 자리에서 다시 계산해 대표점과 비교해요. 추천 순위는 바뀌지 않아요.</p>
    </header>

    <label htmlFor={`${id}-q`} className="point-label">이름으로 위치 정하기</label>
    <div className="place-search"><Search size={17} aria-hidden="true" />
      <input id={`${id}-q`} role="combobox" aria-autocomplete="list" aria-expanded={listOpen} aria-controls={`${id}-list`} aria-activedescendant={listOpen && matches[active] ? `${id}-o-${active}` : undefined} autoComplete="off" placeholder="예: 신림역, 봉천동, 서울대" value={query}
        onFocus={() => { askPlaces(); setOpen(true) }}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, Math.max(matches.length - 1, 0))) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); const p = matches[active]; if (p) choose(p) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
    </div>
    {listOpen && <ul className="place-results" id={`${id}-list`} role="listbox" aria-label="위치 검색 결과">
      {matches.map((p, i) => <li key={p.id} id={`${id}-o-${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={e => { e.preventDefault(); choose(p) }} onMouseEnter={() => setActive(i)}><strong>{p.name}</strong><small>{p.category}{p.address && p.address !== '동네 대표점' ? ` · ${p.address}` : ''}</small></li>)}
      {!matches.length && <li className="no-result" role="presentation">찾는 장소가 없어요. 지도에서 직접 눌러 주세요.</li>}
    </ul>}
    <p className="place-help">지도에서 누르거나, 이름으로 찾은 곳에서 계산해요.</p>

    <div aria-live="polite">
      {load.status === 'loading' && point && <p className="ai-status"><LoaderCircle className="spin" size={14} aria-hidden="true" />걷는 길과 시설 자료를 불러오는 중이에요…</p>}
      {load.status === 'error' && <p className="ai-status error" role="alert">{load.message}</p>}
      {!point && load.status !== 'error' && <p className="point-empty">아직 고른 위치가 없어요. 지도에서 한 곳을 눌러 보세요.</p>}
      {point && !area && load.status === 'ready' && <p className="notice warn">이 위치는 비교할 수 있는 서울 동네 경계 밖이에요. 다른 곳을 골라 주세요.</p>}
      {point && area && metrics && rows && <section className="point-result" aria-labelledby="point-place">
        <div className="point-place">
          <div><h3 id="point-place">{point.name}</h3><p className="meta">{area.district} {area.name} 안 · 동 대표점에서 {dist(distanceFrom(area, point.latitude, point.longitude))}</p></div>
          <button type="button" className="btn btn-icon btn-ghost" aria-label="고른 위치 지우기" onClick={onClear}><X size={16} aria-hidden="true" /></button>
        </div>
        <p className="point-walk"><TrainFront size={16} aria-hidden="true" />{metrics.walk ? <>{metrics.walk.station ? withYeok(metrics.walk.station) : '가까운 지하철'} 출입구까지 걸어서 <b>약 {metrics.walk.minutes}분</b> ({dist(metrics.walk.meters)})</> : '역 출입구까지 연결된 보행 경로를 확인하지 못했어요.'}</p>
        <p className="hint">{atRepresentative ? '동 대표점의 보행 경로와 교통 점수를 표시해요.' : '도보 거리와 시간은 50m 격자 중심에서 계산한 추정값이에요.'}</p>
        <p className="point-summary">{summaryOf(metrics, area)}</p>
        <div className="point-table"><table>
          <caption className="sr-only">고른 위치와 {area.name} 대표점 비교</caption>
          <thead><tr><th scope="col">항목</th><th scope="col">이 위치</th><th scope="col">대표점</th><th scope="col">차이</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.label} className={r.label.endsWith('점수') ? 'score-row' : ''}><th scope="row">{r.label}</th><td>{r.here}</td><td>{r.rep}</td><td className={`diff ${r.tone}`}>{r.diff}</td></tr>)}</tbody>
        </table></div>
        <p className="hint">안전시설 점수는 안심귀갓길 CCTV·안심벨 등이 가까이 많은지예요(2022년 조사). 실제로 안전한 정도나 범죄 위험을 뜻하지 않아요.</p>
        <p className="hint">주거비는 동 전체 거래로만 집계돼 있어 위치마다 다시 계산하지 않아요. {area.name}의 시세는 동네 리포트에서 확인하세요.</p>
        <button type="button" className="btn btn-secondary btn-sm point-open" onClick={() => onOpenArea(area.code)}>{area.name} 리포트 보기<ChevronRight size={14} aria-hidden="true" /></button>
        <details className="fold tech"><summary>이 계산의 한계<ChevronDown size={15} aria-hidden="true" /></summary>
          <ul className="fold-list">
            <li>동 대표점에서는 리포트와 같은 보행 경로를 사용해요. 다른 위치에서는 고른 자리에서 최대 약 35m 떨어진 50m 격자 칸 중심의 경로를 사용해요.</li>
            <li>OpenStreetMap 보행 도로망과 지하철 출입구로 동 대표점과 같은 방식(최단 거리, 일반 길 4.5km/h · 계단 0.8m/s)으로 계산했어요. 신호 대기·공사·휠체어 접근성은 반영하지 않아요.</li>
            <li>안전시설은 서울시 안심귀갓길 자료에 있는 시설만 세요(2022년 조사). 서울 전체 CCTV나 범죄 위험을 뜻하지 않아요.</li>
            <li>버스정류장과 병원·약국·응급실은 직선거리예요. 점수는 서울 전체 동의 대표점과 견준 상대 점수(0~100)예요.</li>
          </ul>
        </details>
      </section>}
    </div>
  </article>
}
