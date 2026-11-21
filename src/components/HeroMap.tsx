import { useMemo } from 'react'
import { seoulDistricts } from '../lib/seoul.ts'
import type { Area, Recommendation } from '../lib/types.ts'

// 첫 화면의 서울 그림 지도. 실제 구 경계(seoulDistricts)를 종이 지도처럼 그리고,
// 한강·큰 공원은 대략의 위치로 얹는다. 장식용이라 스크린리더에는 숨긴다.
const W0 = 126.755, E0 = 127.19, N0 = 37.716, S0 = 37.413
const K = 2000, COS = Math.cos((37.56 * Math.PI) / 180)
export const HERO_W = Math.round((E0 - W0) * COS * K)
export const HERO_H = Math.round((N0 - S0) * K)
const px = (lng: number) => (lng - W0) * COS * K
const py = (lat: number) => (N0 - lat) * K

type Ring = number[][]
const ringPath = (ring: Ring) => ring.map(([lng, lat], i) => `${i ? 'L' : 'M'}${px(lng).toFixed(1)} ${py(lat).toFixed(1)}`).join('') + 'Z'

// 한강 중심선(서→동). 실제 물길을 단순화한 근사치.
const RIVER: [number, number][] = [
  [126.62, 37.66], [126.70, 37.63], [126.765, 37.604], [126.81, 37.586], [126.855, 37.566], [126.895, 37.549],
  [126.925, 37.534], [126.955, 37.521], [126.98, 37.514], [127.005, 37.518], [127.03, 37.528], [127.052, 37.536],
  [127.075, 37.527], [127.095, 37.52], [127.115, 37.533], [127.14, 37.548], [127.18, 37.574], [127.215, 37.585],
]
const riverPath = RIVER.map(([lng, lat], i) => `${i ? 'L' : 'M'}${px(lng).toFixed(1)} ${py(lat).toFixed(1)}`).join('')

// 산과 큰 공원(대략 위치, 반지름 m)
const PARKS: [number, number, number, number][] = [
  [126.985, 37.66, 2600, 1700], [126.958, 37.444, 1800, 1100], [126.99, 37.551, 650, 420], [127.121, 37.52, 700, 520],
  [127.041, 37.544, 520, 380], [126.884, 37.568, 900, 520], [127.03, 37.448, 1300, 800], [127.095, 37.64, 1300, 900],
]

interface Props { areas: Area[]; picks: Recommendation[] | null }

export default function HeroMap({ areas, picks }: Props) {
  const districts = useMemo(() => seoulDistricts.features.map(f => {
    const polys: Ring[] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0] as Ring] : (f.geometry.coordinates as Ring[][]).map(p => p[0])
    const all = polys.flat()
    const cx = all.reduce((s, c) => s + c[0], 0) / all.length, cy = all.reduce((s, c) => s + c[1], 0) / all.length
    return { name: String(f.properties?.SIG_KOR_NM ?? ''), d: polys.map(ringPath).join(''), x: px(cx), y: py(cy) }
  }), [])
  const outline = useMemo(() => districts.map(d => d.d).join(''), [districts])
  const top = picks?.[0]

  return <div className="hero-map-box" style={{ aspectRatio: `${HERO_W} / ${HERO_H}` }}>
    <svg viewBox={`0 0 ${HERO_W} ${HERO_H}`} preserveAspectRatio="xMidYMid meet" focusable="false">
      <defs>
        <pattern id="blocks" width="19" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
          <rect x="1.5" y="1.5" width="16" height="11" rx="2.5" className="hm-block" />
        </pattern>
        <clipPath id="seoul-clip"><path d={outline} /></clipPath>
      </defs>
      <path d={outline} className="hm-land" />
      <rect width={HERO_W} height={HERO_H} fill="url(#blocks)" clipPath="url(#seoul-clip)" />
      {PARKS.map(([lng, lat, rx, ry], i) => <g key={i} clipPath="url(#seoul-clip)">
        <ellipse cx={px(lng)} cy={py(lat)} rx={(rx / 111000) * K} ry={(ry / 111000) * K} className="hm-park" />
        {[[-.35, -.2], [.25, -.3], [-.1, .25], [.4, .15]].map(([dx, dy], j) => <circle key={j} cx={px(lng) + dx * (rx / 111000) * K} cy={py(lat) + dy * (ry / 111000) * K} r="2.4" className="hm-tree" />)}
      </g>)}
      <path d={riverPath} className="hm-river" />
      {districts.map(d => <path key={d.name} d={d.d} className="hm-district" />)}
      {areas.map(a => <circle key={a.code} cx={px(a.longitude)} cy={py(a.latitude)} r="1.7" className="hm-dot" />)}
      {districts.map(d => <text key={d.name} x={d.x} y={d.y} className="hm-label">{d.name}</text>)}
      <text x={px(126.86)} y={py(37.552) + 22} className="hm-river-label" transform={`rotate(-17 ${px(126.86)} ${py(37.552) + 22})`}>한 강</text>
    </svg>
    {picks?.map(r => <span key={r.area.code} className={`hm-pin ${r === top ? 'top' : ''}`} style={{ left: `${(px(r.area.longitude) / HERO_W) * 100}%`, top: `${(py(r.area.latitude) / HERO_H) * 100}%` }}>
      <b>{r.rank}</b>{r.area.name}
    </span>)}
  </div>
}
