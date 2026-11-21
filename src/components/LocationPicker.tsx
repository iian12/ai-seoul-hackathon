import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { MapPin, Search, X } from 'lucide-react'
import { rankPlaces, stationPlaces } from '../ui/placeSearch.ts'
import type { Place } from '../lib/location.ts'
import type { Area, LocationFilter } from '../lib/types.ts'

interface Props { areas: Area[]; value?: LocationFilter; radiusKm: number; picking: boolean; onRadius: (km: number) => void; onChange: (point?: LocationFilter) => void; onPick: () => void }
type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export default function LocationPicker({ areas, value, radiusKm, picking, onRadius, onChange, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<Place[]>([])
  const [load, setLoad] = useState<LoadState>('idle')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const id = useId()
  const deferredQuery = useDeferredValue(query)

  // 장소 목록(용량이 큼)은 검색창을 처음 쓸 때만 받는다. 동 이름 검색과 지도 지정은 바로 쓸 수 있다.
  function ensurePlaces() {
    if (load === 'loading' || load === 'ready') return
    setLoad('loading')
    controller.current?.abort()
    const c = new AbortController(); controller.current = c
    fetch('/data/seoul-places.json', { signal: c.signal }).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('missing index')
      const data = await response.json()
      if (!Array.isArray(data.places)) throw new Error('invalid index')
      setPlaces(data.places); setLoad('ready')
    }).catch(() => { if (!c.signal.aborted) setLoad('error') })
  }

  const index = useMemo(() => [...stationPlaces, ...areas.map(a => ({ id: a.code, name: `${a.district} ${a.name}`, address: '동네 대표점', category: '동네', latitude: a.latitude, longitude: a.longitude })), ...places], [areas, places])
  const matches = useMemo(() => rankPlaces(index, deferredQuery), [index, deferredQuery])
  const listOpen = open && query.trim().length >= 2
  function choose(p: Place) { onChange({ name: p.name, latitude: p.latitude, longitude: p.longitude, radiusKm }); setQuery(''); setOpen(false); setActive(0); setChanging(false) }
  const status = load === 'loading' ? '학교·회사 목록을 불러오는 중이에요. 동 이름은 바로 찾을 수 있어요.'
    : load === 'error' ? '학교·회사 목록을 불러오지 못했어요. 동 이름으로 찾거나 지도에서 직접 골라 주세요.'
    : '학교·회사·건물 이름이나 동 이름으로 찾아보세요.'

  const [changing, setChanging] = useState(false)
  const showSearch = !value || changing
  return <div className="location-section">
    {value && <div className="chosen-location"><MapPin size={17} aria-hidden="true" /><div><strong>{value.name}</strong><small>기준 {radiusKm}km 안의 동네만 비교해요</small></div><button type="button" onClick={() => { onChange(); setQuery(''); setOpen(false); setChanging(false) }}><X size={16} aria-hidden="true" /> 해제</button></div>}
    {value && !changing && <button type="button" className="change-location" onClick={() => setChanging(true)}>다른 곳으로 바꾸기</button>}
    {showSearch && <>
    <label htmlFor={`${id}-input`}>기준 위치 찾기</label>
    <div className="place-search"><Search size={17} aria-hidden="true" />
      <input
        id={`${id}-input`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={`${id}-list`}
        aria-activedescendant={listOpen && matches[active] ? `${id}-opt-${active}` : undefined}
        aria-describedby={`${id}-help`}
        autoComplete="off"
        placeholder="예: 서울대, 강남역, 역삼동"
        value={query}
        onFocus={() => { ensurePlaces(); setOpen(true) }}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, Math.max(matches.length - 1, 0))) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); const p = matches[active]; if (p) choose(p) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
    </div>
    {listOpen && <ul className="place-results" id={`${id}-list`} role="listbox" aria-label="기준 위치 검색 결과">
      {matches.map((p, i) => <li key={p.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={e => { e.preventDefault(); choose(p) }} onMouseEnter={() => setActive(i)}><strong>{p.name}</strong><small>{p.category}{p.address && p.address !== '동네 대표점' ? ` · ${p.address}` : ''}</small></li>)}
      {!matches.length && <li className="no-result" role="presentation">{load === 'loading' ? '목록을 불러오는 중이에요…' : '찾는 장소가 없어요. 지도에서 직접 골라 주세요.'}</li>}
    </ul>}
    <p className="place-help" id={`${id}-help`}>{status}</p>
    <button type="button" className={`pick-location ${picking ? 'selected' : ''}`} onClick={onPick} aria-pressed={picking}><MapPin size={16} aria-hidden="true" />{picking ? '지도에서 고르기 취소' : '지도에서 직접 고르기'}</button>
    </>}
    <label htmlFor={`${id}-radius`} className="radius-label">주변 반경 <b>{radiusKm}km</b></label>
    <input id={`${id}-radius`} className="radius-range" type="range" min="0.5" max="20" step="0.5" value={radiusKm} onChange={e => onRadius(Number(e.target.value))} aria-valuetext={`${radiusKm}킬로미터`} />
    <div className="radius-presets">{[1, 3, 5, 10].map(km => <button key={km} type="button" className={radiusKm === km ? 'selected' : ''} aria-pressed={radiusKm === km} onClick={() => onRadius(km)}>{km}km</button>)}</div>
    <p className="place-help">동네 중심점까지의 직선거리예요. 실제 통학·출근 시간과는 다를 수 있어요.</p>
    <a className="place-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">장소 정보 © OpenStreetMap contributors</a>
  </div>
}
