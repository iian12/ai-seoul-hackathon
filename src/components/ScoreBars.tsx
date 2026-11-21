import type { CSSProperties } from 'react'
import { domains } from '../lib/types.ts'
import type { Domain, Scores } from '../lib/types.ts'

// 화면에 보이는 영역 이름. 계산 로직(recommend.ts)의 키는 그대로 두고 표시 이름만 바꾼다.
export const domainLabels: Record<Domain, string> = { policing: '치안', safety: '안전시설', transit: '교통', housing: '예산 맞춤', medical: '병원·약국' }

export default function ScoreBars({ scores, compact = false, only, emph = [] }: { scores: Scores; compact?: boolean; only?: readonly Domain[]; emph?: readonly Domain[] }) {
  const shown = only ?? domains
  return <div className={`score-bars ${compact ? 'compact' : ''}`} style={compact ? ({ '--bar-cols': shown.length } as CSSProperties) : undefined}>{shown.map(k => <div className={`score-bar ${k} ${emph.includes(k) ? 'emph' : ''}`} key={k}>
    <span>{domainLabels[k]}{emph.includes(k) && <small className="emph-tag">중요</small>}</span><div className="bar-track" role="presentation"><div style={{ width: `${Math.max(0, Math.min(100, scores[k] ?? 0))}%` }} /></div><b>{(scores[k] ?? 0).toFixed(0)}<span className="sr-only">점</span></b>
  </div>)}</div>
}
