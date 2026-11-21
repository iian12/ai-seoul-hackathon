import { X } from 'lucide-react'
import { DISTRICT_NAMES, districtLabel } from '../ui/districts.ts'

/** 구 여러 개 고르기: 고른 구 안의 동네만 비교한다. */
export default function DistrictPicker({ value, onChange, idPrefix }: { value: string[]; onChange: (next: string[]) => void; idPrefix: string }) {
  const toggle = (d: string) => onChange(value.includes(d) ? value.filter(x => x !== d) : [...value, d].sort((a, b) => a.localeCompare(b, 'ko')))
  return <div className="district-picker">
    <div className="district-head">
      <p id={`${idPrefix}-help`}>{value.length ? <><b>{districtLabel(value)}</b> 안에서만 찾아요</> : '고르지 않으면 서울 전체에서 찾아요. 여러 구를 고를 수 있어요.'}</p>
      {value.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}><X size={14} aria-hidden="true" />구 선택 해제</button>}
    </div>
    <div className="district-chips" role="group" aria-label="구 고르기" aria-describedby={`${idPrefix}-help`}>
      {DISTRICT_NAMES.map(d => <button key={d} type="button" className="chip" aria-pressed={value.includes(d)} onClick={() => toggle(d)}>{d}</button>)}
    </div>
  </div>
}
