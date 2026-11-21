import { useId, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Area } from '../lib/types.ts'

const normalize = (s: string) => s.normalize('NFC').replace(/\s+/g, '')

interface Props { areas: Area[]; recent: Area[]; onSelect: (code: string) => void; compact?: boolean }

/** 동네 이름 검색. 입력하면 좁혀지는 콤보박스(↑↓·Enter·Esc). */
export default function AreaSearch({ areas, recent, onSelect, compact = false }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const id = useId()
  const matches = useMemo(() => {
    const q = normalize(query)
    if (!q) return []
    return areas
      .filter(a => normalize(`${a.district}${a.name}`).includes(q) || normalize(a.name).includes(q))
      .sort((a, b) => Number(normalize(b.name).startsWith(q)) - Number(normalize(a.name).startsWith(q)) || `${a.district} ${a.name}`.localeCompare(`${b.district} ${b.name}`, 'ko'))
      .slice(0, 8)
  }, [areas, query])
  const listOpen = open && query.trim().length > 0
  function choose(a: Area) { onSelect(a.code); setQuery(''); setOpen(false); setActive(0) }

  return <section className={`area-search ${compact ? 'compact' : ''}`} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className={compact ? 'sr-only' : ''}>동네 이름으로 찾아보기</h3>
    {!compact && <p className="field-description">마음에 둔 동네가 있다면 이름으로 찾아보세요. 내 조건에서 어떤지 알려드려요.</p>}
    <div className="place-search">
      <Search size={17} aria-hidden="true" />
      <input
        id={`${id}-input`}
        role="combobox"
        aria-label="동네 이름으로 찾기"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={`${id}-list`}
        aria-activedescendant={listOpen && matches[active] ? `${id}-opt-${matches[active].code}` : undefined}
        autoComplete="off"
        placeholder={compact ? '동네 이름으로 찾기 (예: 신림동)' : '예: 신림동, 마포구'}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, Math.max(matches.length - 1, 0))) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); const a = matches[active]; if (a) choose(a) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {query && <button type="button" className="clear-input" aria-label="검색어 지우기" onClick={() => { setQuery(''); setOpen(false) }}><X size={16} /></button>}
    </div>
    {listOpen && <ul className="place-results" id={`${id}-list`} role="listbox" aria-label="동네 검색 결과">
      {matches.map((a, i) => <li key={a.code} id={`${id}-opt-${a.code}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={e => { e.preventDefault(); choose(a) }} onMouseEnter={() => setActive(i)}>
        <strong>{a.name}</strong><small>{a.district}</small>
      </li>)}
      {!matches.length && <li className="no-result" role="presentation">찾는 동네가 없어요. 법정동 이름(예: 봉천동, 신림동)으로 찾아보세요.</li>}
    </ul>}
    {recent.length > 0 && !compact && <div className="recent-areas"><span>최근 본 동네</span>{recent.map(a => <button type="button" key={a.code} onClick={() => onSelect(a.code)}>{a.district} {a.name}</button>)}</div>}
  </section>
}
