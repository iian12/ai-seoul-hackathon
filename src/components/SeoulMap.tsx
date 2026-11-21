import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { LocateFixed, TriangleAlert } from 'lucide-react'
import { isInSeoul, seoulDistricts } from '../lib/seoul.ts'
import type { Area, LocationFilter, Recommendation } from '../lib/types.ts'
import { STATIONS } from '../ui/stations.ts'

/** 동네의 기준역: 도보 경로가 닿는 지하철 출입구에서 가장 가까운 역(없으면 동네 중심에서 가장 가까운 역) */
const metersBetween = (aLat: number, aLng: number, bLat: number, bLng: number) => Math.hypot((aLat - bLat) * 111000, (aLng - bLng) * 88300)
function stationOf(area: Area) {
  const end = area.walking?.status === 'ok' ? area.walking.geometry?.coordinates.at(-1) : undefined
  const [lng, lat] = end ?? [area.longitude, area.latitude]
  let best = STATIONS[0], bd = Infinity
  for (const st of STATIONS) { const d = metersBetween(lat, lng, st.lat, st.lng); if (d < bd) { bd = d; best = st } }
  return best
}
/** 점이 동네 경계 안에 있는지(다각형·다중다각형) */
function inBoundary(b: GeoJSON.Polygon | GeoJSON.MultiPolygon, lat: number, lng: number) {
  const ring = (r: number[][]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c } return c }
  const polys = b.type === 'Polygon' ? [b.coordinates] : b.coordinates
  return polys.some(p => ring(p[0]) && !p.slice(1).some(ring))
}

interface Spot { latitude: number; longitude: number; name: string }
interface Props { areas: Area[]; recommendations: Recommendation[]; selected: string | null; onSelect: (code: string) => void; location?: LocationFilter; picking: boolean; onPickLocation: (latitude: number, longitude: number) => void; excluded?: Set<string>; checking?: boolean; checkPoint?: Spot | null; checkRep?: Spot | null; onCheck?: (latitude: number, longitude: number) => void }
export default function SeoulMap({ areas, recommendations, selected, onSelect, location, picking, onPickLocation, excluded, checking = false, checkPoint, checkRep, onCheck }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const areaRenderer = useRef<L.Canvas | null>(null)
  const stationRenderer = useRef<L.SVG | null>(null)
  const [tileFailed, setTileFailed] = useState(false)
  const [mapFailed, setMapFailed] = useState(false)
  const [pickError, setPickError] = useState('')
  const callback = useRef(onSelect)
  callback.current = onSelect
  const pickCallback = useRef(onPickLocation)
  pickCallback.current = onPickLocation
  // 화면 크기가 바뀌면(휴대폰 회전, 넓은 화면 고정 지도) 지금 보여줘야 할 범위로 다시 맞춘다.
  const refit = useRef<(() => void) | null>(null)
  const checkCallback = useRef(onCheck)
  checkCallback.current = onCheck
  const checkLayer = useRef<L.LayerGroup | null>(null)
  const checkFit = useRef<(() => void) | null>(null)
  // 지도 클릭이 동네 열기 대신 위치 지정으로 쓰이는 상태(기준 위치 고르기 · 위치 찍어 보기)
  const pickingRef = useRef(picking || checking)
  pickingRef.current = picking || checking
  const checkingRef = useRef(checking)
  checkingRef.current = checking
  useEffect(() => { setPickError('') }, [picking, checking])

  useEffect(() => {
    if (!root.current) return
    try {
      const m = L.map(root.current, { center: [37.565, 126.977], zoom: 10, minZoom: 9, maxZoom: 16, maxBounds: [[37.425, 126.755], [37.71, 127.19]], maxBoundsViscosity: 1, scrollWheelZoom: true, wheelPxPerZoomLevel: 90, zoomSnap: .25, zoomDelta: .5, zoomControl: false })
      m.fitBounds([[37.425, 126.755], [37.71, 127.19]], { padding: [15, 15], maxZoom: 11 })
      map.current = m
      m.on('click', e => {
        if (!pickingRef.current) return
        if (!isInSeoul(e.latlng.lat, e.latlng.lng)) { setPickError('서울 경계 안을 선택해 주세요.'); return }
        setPickError('')
        if (checkingRef.current) checkCallback.current?.(e.latlng.lat, e.latlng.lng)
        else pickCallback.current(e.latlng.lat, e.latlng.lng)
      })
      L.control.zoom({ position: 'topright' }).addTo(m)
      L.control.scale({ position: 'topleft', imperial: false, maxWidth: 90 }).addTo(m)
      m.attributionControl.addAttribution('<a href="https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&amp;dsId=21">국토교통부 브이월드 법정구역정보</a>')
      // OSM 기본 지도를 종이 지도 톤으로 눌러서 쓴다(키 없이 쓸 수 있는 공개 타일).
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, bounds: [[37.425, 126.755], [37.71, 127.19]], attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', crossOrigin: true, className: 'base-tiles' }).on('tileerror', () => setTileFailed(true)).addTo(m)
      m.createPane('seoul-mask').style.zIndex = '410'
      const holes = seoulDistricts.features.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map(p => p[0]))
      const coords = [[[126, 36.8], [128, 36.8], [128, 38.3], [126, 38.3], [126, 36.8]], ...holes]
      const mask: GeoJSON.Feature<GeoJSON.Polygon> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } }
      L.geoJSON(mask, { pane: 'seoul-mask', interactive: false, style: { color: '#bfb39c', weight: 1, fillColor: '#e7dfcf', fillOpacity: .82, fillRule: 'evenodd' } }).addTo(m)
      L.geoJSON(seoulDistricts, { interactive: false, style: { color: '#bfb39c', weight: 1, fillOpacity: 0, dashArray: '2 5' } }).addTo(m)
      // 구 이름: 서울 전체를 볼 때만 띄엄띄엄 쓴 글씨로 보여준다.
      m.createPane('gu-labels').style.zIndex = '415'
      seoulDistricts.features.forEach(f => {
        const center = L.geoJSON(f).getBounds().getCenter()
        L.marker(center, { pane: 'gu-labels', interactive: false, keyboard: false, icon: L.divIcon({ className: 'gu-label', html: String(f.properties?.SIG_KOR_NM ?? ''), iconSize: [0, 0] }) }).addTo(m)
      })
      const zoomClass = () => root.current?.classList.toggle('zoomed-in', m.getZoom() >= 13)
      m.on('zoomend', zoomClass); zoomClass()
      m.createPane('areas').style.zIndex = '405'
      areaRenderer.current = L.canvas({ pane: 'areas', padding: .4, tolerance: 2 })
      m.createPane('stations').style.zIndex = '420'
      stationRenderer.current = L.svg({ pane: 'stations', padding: .4 })
      layer.current = L.layerGroup().addTo(m)
      m.createPane('check').style.zIndex = '640'
      checkLayer.current = L.layerGroup().addTo(m)
      let last = ''
      const observer = new ResizeObserver(entries => {
        const r = entries[0]?.contentRect
        const size = r ? `${Math.round(r.width)}x${Math.round(r.height)}` : ''
        m.invalidateSize()
        // 처음 크기가 잡힐 때와 크기가 바뀔 때 지금 보여줄 범위로 다시 맞춘다.
        if (size && size !== last) refit.current?.()
        last = size
      })
      observer.observe(root.current)
      return () => { observer.disconnect(); m.remove(); map.current = null; layer.current = null; checkLayer.current = null }
    } catch { setMapFailed(true) }
  }, [])

  // 동네마다 기준역을 정하고, 같은 역을 쓰는 동네끼리 묶는다(흰 점 = 역)
  const stationGroups = useMemo(() => {
    const groups = new Map<string, { name: string; lat: number; lng: number; lines: string[]; areas: Area[] }>()
    areas.forEach(a => { const st = stationOf(a); const g = groups.get(st.name) ?? { ...st, areas: [] }; g.areas.push(a); groups.set(st.name, g) })
    return [...groups.values()]
  }, [areas])

  useEffect(() => {
    const m = map.current, group = layer.current
    if (!m || !group) return
    group.clearLayers()
    const fit = () => {
      if (checkFit.current) { checkFit.current(); return }
      if (location) { m.fitBounds(L.latLng(location.latitude, location.longitude).toBounds(location.radiusKm * 2000), { padding: [30, 45], maxZoom: 14, animate: false }); return }
      const t = areas.find(a => a.code === selected)
      if (t?.walking?.status === 'ok' && t.walking.geometry) { m.fitBounds(L.geoJSON({ type: 'Feature', properties: {}, geometry: t.walking.geometry } as GeoJSON.Feature).getBounds().pad(.15), { padding: [35, 35], maxZoom: 15, animate: false }); return }
      if (t) { m.setView([t.latitude, t.longitude], Math.max(m.getZoom(), 13), { animate: false }); return }
      if (recommendations.length) { m.fitBounds(L.latLngBounds(recommendations.map(r => [r.area.latitude, r.area.longitude] as L.LatLngTuple)).pad(.35), { padding: [40, 40], maxZoom: 14, animate: false }); return }
      m.fitBounds([[37.425, 126.755], [37.71, 127.19]], { padding: [15, 15], maxZoom: 11, animate: false })
    }
    refit.current = fit
    if (location) {
      const circle = L.circle([location.latitude, location.longitude], { radius: location.radiusKm * 1000, color: '#cc451a', weight: 1.5, dashArray: '2 6', lineCap: 'round', fillColor: '#cc451a', fillOpacity: .05, interactive: false }).addTo(group)
      const label = document.createElement('span'); label.textContent = `${location.name} · 반경 ${location.radiusKm}km`
      L.circleMarker([location.latitude, location.longitude], { radius: 7, color: '#fff', weight: 3, fillColor: '#cc451a', fillOpacity: 1, interactive: false }).bindTooltip(label, { permanent: true, direction: 'top', className: 'anchor-map-label' }).addTo(group)
      m.fitBounds(circle.getBounds(), { padding: [30, 45], maxZoom: 14, animate: false })
    } else if (!selected && recommendations.length) {
      // 결과 직후에는 TOP 3를 한 화면에 모두 보여준다. 카드를 누르면 그 동네로 확대한다.
      m.fitBounds(L.latLngBounds(recommendations.map(r => [r.area.latitude, r.area.longitude] as L.LatLngTuple)).pad(.35), { padding: [40, 40], maxZoom: 14, animate: false })
    } else if (!selected) m.fitBounds([[37.425, 126.755], [37.71, 127.19]], { padding: [15, 15], maxZoom: 11, animate: false })
    areas.forEach(area => {
      const match = recommendations.find(r => r.area.code === area.code)
      const active = selected === area.code
      // 동네 경계 전체가 눌리는 영역: 마우스를 올리면 경계가 진해지고 이름이 뜬다.
      // 결과가 있으면 예산 안 후보 동네는 옅게 칠하고, 빠진 동네는 칠하지 않는다.
      if (area.boundary) {
        const out = excluded?.has(area.code), candidate = !!excluded && !out
        const base: L.PathOptions = { renderer: areaRenderer.current ?? undefined, color: '#1b1a17', weight: .6, opacity: candidate ? .32 : .16, fill: true, fillColor: candidate ? '#cc451a' : '#1b1a17', fillOpacity: candidate ? .07 : 0, bubblingMouseEvents: true }
        const poly = L.geoJSON({ type: 'Feature', properties: {}, geometry: area.boundary } as GeoJSON.Feature, { style: () => base })
        poly.bindTooltip(`${area.district} ${area.name}`, { sticky: true, direction: 'top', offset: [0, -8], className: 'area-map-label' })
          .on('mouseover', () => poly.setStyle({ weight: 1.6, opacity: .85, fillOpacity: candidate ? .14 : .06 }))
          .on('mouseout', () => poly.setStyle(base))
          .on('click', () => { if (!pickingRef.current) callback.current(area.code) })
          .addTo(group)
      }
      if (areas.length > 50 && !match && !active) return
      const button = document.createElement('button')
      button.type = 'button'
      // 추천 동네는 이름이 적힌 알약 핀(순위 + 동 이름), 고른 동네는 주황색.
      button.className = `map-pin ${match ? 'recommended' : ''} ${match?.rank === 1 ? 'top' : ''} ${active ? 'active' : ''}`
      button.dataset.code = area.code
      // 핀에 마우스를 올리면 목록의 같은 카드도 표시한다
      button.addEventListener('mouseenter', () => document.querySelector(`#card-${area.code} .rec-card`)?.classList.add('linked'))
      button.addEventListener('mouseleave', () => document.querySelector(`#card-${area.code} .rec-card`)?.classList.remove('linked'))
      button.setAttribute('aria-label', `${area.district} ${area.name}${match ? ` 추천 ${match.rank}위` : ''} 상세 보기`)
      if (match) { const rank = document.createElement('b'); rank.textContent = String(match.rank); button.append(rank) }
      button.append(area.name)
      button.addEventListener('click', e => {
        e.stopPropagation()
        // 위치 찍기 중에는 이름 핀을 눌러도 그 자리를 점검한다
        if (checkingRef.current) { checkCallback.current?.(area.latitude, area.longitude); return }
        callback.current(area.code)
      })
      const icon = L.divIcon({ className: 'map-icon', html: button, iconSize: [0, 0], iconAnchor: [0, 0] })
      L.marker([area.latitude, area.longitude], { icon, keyboard: false, zIndexOffset: active ? 1000 : match ? 500 : 0 }).addTo(group)
      if (area.boundary && (match || active)) {
        const boundary: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: area.boundary }
        L.geoJSON(boundary, { interactive: false, style: { color: active ? '#cc451a' : '#1b1a17', weight: active ? 2 : 1, opacity: active ? 1 : .5, fillOpacity: active ? .08 : .04, fillColor: active ? '#cc451a' : '#1b1a17' } }).addTo(group)
      }
    })
    // 흰 점 = 동네의 기준역. 누르면 그 역이 있는 동네(없으면 이 역을 쓰는 첫 동네)를 연다.
    stationGroups.forEach(st => {
      const allOut = !!excluded && st.areas.every(a => excluded.has(a.code))
      const home = st.areas.find(a => a.boundary && inBoundary(a.boundary, st.lat, st.lng)) ?? st.areas[0]
      L.circleMarker([st.lat, st.lng], { renderer: stationRenderer.current ?? undefined, radius: 3.8, weight: 1.7, color: '#1b1a17', opacity: allOut ? .3 : .75, fillColor: '#fffdf8', fillOpacity: 1, bubblingMouseEvents: false })
        .bindTooltip(`<b>${st.name}역</b> · ${st.lines.join(' · ')}<br>${st.areas.map(a => a.name).slice(0, 4).join(', ')}${st.areas.length > 4 ? ` 외 ${st.areas.length - 4}곳` : ''}의 기준역`, { direction: 'top', offset: [0, -4], className: 'station-map-label' })
        .on('click', () => { if (checkingRef.current) checkCallback.current?.(st.lat, st.lng); else if (!pickingRef.current) callback.current(home.code) })
        .addTo(group)
    })
    const target = areas.find(a => a.code === selected)
    if (target?.walking?.status === 'ok' && target.walking.geometry) {
      const walk: GeoJSON.Feature<GeoJSON.LineString> = { type: 'Feature', properties: {}, geometry: target.walking.geometry }
      const route = L.geoJSON(walk, { interactive: false, style: { color: '#1b1a17', weight: 3, opacity: .85, dashArray: '1 7', lineCap: 'round' } }).addTo(group)
      if (!location) { const st = stationOf(target); m.fitBounds(route.getBounds().extend([st.lat, st.lng]).pad(.15), { padding: [35, 35], maxZoom: 15, animate: false }) }
    } else if (target && !m.getBounds().pad(-.1).contains([target.latitude, target.longitude])) m.panTo([target.latitude, target.longitude], { animate: false })
    // 선택한 동네의 기준역은 지도 위 흰 점과 같은 자리에 크게 표시한다(점이 두 개로 갈라지지 않게).
    // 도보 경로는 지하철 출입구에서 끝나므로, 출입구에서 역 점까지는 같은 점선으로 잇는다.
    if (target) {
      const st = stationOf(target)
      const end = target.walking?.status === 'ok' ? target.walking.geometry?.coordinates.at(-1) : undefined
      if (end && metersBetween(end[1], end[0], st.lat, st.lng) > 8) L.polyline([[end[1], end[0]], [st.lat, st.lng]], { interactive: false, color: '#1b1a17', weight: 3, opacity: .85, dashArray: '1 7', lineCap: 'round' }).addTo(group)
      L.circleMarker([st.lat, st.lng], { renderer: stationRenderer.current ?? undefined, radius: 6.5, color: '#1b1a17', weight: 2.8, fillColor: '#fffdf8', fillOpacity: 1, bubblingMouseEvents: false })
        .bindTooltip(`<b>${st.name}역</b> · ${st.lines.join(' · ')}<br>${target.name}의 기준역`, { direction: 'top', offset: [0, -6], className: 'station-map-label' })
        .addTo(group)
    }
  }, [areas, recommendations, selected, location, excluded, stationGroups])

  // 위치 찍어 보기: 고른 자리(먹색 십자 점)와 그 동 대표점(빈 원)을 점선으로 잇는다. 동네 그림과 따로 그려 지도를 다시 맞추지 않는다.
  useEffect(() => {
    const m = map.current, group = checkLayer.current
    if (!m || !group) return
    group.clearLayers()
    checkFit.current = null
    if (!checkPoint) return
    const here: L.LatLngTuple = [checkPoint.latitude, checkPoint.longitude]
    if (checkRep) {
      L.polyline([here, [checkRep.latitude, checkRep.longitude]], { pane: 'check', interactive: false, color: '#1b1a17', weight: 1.6, opacity: .7, dashArray: '3 5' }).addTo(group)
      L.circleMarker([checkRep.latitude, checkRep.longitude], { pane: 'check', radius: 6, color: '#1b1a17', weight: 2, fillColor: '#fffdf8', fillOpacity: 1, interactive: false })
        .bindTooltip(`${checkRep.name} 대표점`, { permanent: true, direction: 'bottom', offset: [0, 6], className: 'check-map-label rep' }).addTo(group)
    }
    const icon = L.divIcon({ className: 'check-pin', html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 13] })
    const label = document.createElement('span'); label.textContent = checkPoint.name
    L.marker(here, { pane: 'check', icon, interactive: false, keyboard: false }).bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -14], className: 'check-map-label' }).addTo(group)
    const bounds = L.latLngBounds([here, ...(checkRep ? [[checkRep.latitude, checkRep.longitude] as L.LatLngTuple] : [])])
    // 크기가 바뀌어 지도를 다시 맞출 때도 찍은 위치를 기준으로 맞춘다
    checkFit.current = () => { m.fitBounds(bounds.pad(.6), { maxZoom: 16, padding: [60, 60], animate: false }); if (m.getZoom() < 14) m.setView(here, 14, { animate: false }) }
    checkFit.current()
  }, [checkPoint, checkRep])

  return <section id="location-map" className={`map-panel ${picking || checking ? 'picking-location' : ''}`} aria-label="서울 추천 지역 지도">
    <div ref={root} className="map-canvas" role="region" aria-label="서울 한정 지도. 아래 지역 목록에서도 같은 상세 정보를 확인할 수 있습니다." />
    <div className="map-compass" aria-hidden="true"><span>N</span></div>
    {(picking || checking) && <div className="map-pick-notice" role="status">{pickError || (checking ? '점검할 자리를 지도에서 누르세요' : '지도 배경을 클릭해 기준 위치를 지정하세요. (서울 안)')}</div>}
    <button className="map-reset" aria-label="서울 전체 지도 보기" onClick={() => map.current?.fitBounds([[37.425, 126.755], [37.71, 127.19]], { padding: [15, 15], maxZoom: 11 })}><LocateFixed size={18} /></button>
    {(tileFailed || mapFailed) && <div className="map-warning" role="status"><TriangleAlert size={16} /> 배경지도를 불러오지 못했습니다. 지역 목록에서 계속 비교할 수 있어요.</div>}
    <div className="map-legend">
      {recommendations.length > 0 && <span><i className="lg-pin" />추천 동네</span>}
      <span><i className="lg-ring" />동네 기준역</span>
      {excluded && <span><i className="lg-area" />예산 안 후보 동네</span>}
      {location && <span><i className="lg-anchor" />기준 위치·반경</span>}
      {checkPoint && <span><i className="lg-check" />찍은 위치</span>}
      {areas.find(a => a.code === selected)?.walking?.status === 'ok' && <span><i className="lg-walk" />역까지 걷는 길</span>}
    </div>
  </section>
}
