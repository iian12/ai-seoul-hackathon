// 결과 안정성: 지금 비중을 조금(5점씩) 옮겨 다시 계산했을 때 TOP 3가 얼마나 그대로인지.
// 계산 규칙(src/lib/recommend.ts)은 그대로 쓴다. 동네별 항목 점수는 비중과 상관없으므로
// 후보 동네의 점수를 한 번만 구해 두고(동네 하나씩 recommend), 비중만 바꿔 같은 규칙으로 다시 줄 세운다.
import { compareRecommendations, normalizeWeights, recommend, weightedScore } from '../lib/recommend.ts'
import { domains } from '../lib/types.ts'
import type { Recommendation, Results, Snapshot, Weights } from '../lib/types.ts'

export const SHIFT = 5
export interface Stability {
  total: number
  /** 동네 코드 → 바꿔 본 경우 가운데 TOP 3에서 빠진 횟수 */
  drops: Record<string, number>
  /** 동네 코드 → 빠졌을 때 가장 자주 대신 들어온 동네 이름 */
  instead: Record<string, string | null>
}

/** 한 항목에서 다른 항목으로 5점을 옮기는 모든 경우(최대 12가지) */
export function variants(effective: Weights): Weights[] {
  const base = Object.fromEntries(domains.map(k => [k, (effective[k] ?? 0) * 100])) as Weights
  const out: Weights[] = []
  for (const from of domains) for (const to of domains) {
    if (from === to || (base[from] ?? 0) < SHIFT) continue
    out.push({ ...base, [from]: (base[from] ?? 0) - SHIFT, [to]: (base[to] ?? 0) + SHIFT })
  }
  return out
}

/** 화면에 차례를 넘긴다. 탭이 가려져 있어도 타이머처럼 늦춰지지 않게 MessageChannel을 쓴다. */
const yieldToPage = () => new Promise<void>(resolve => {
  if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return }
  const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); resolve() }; ch.port2.postMessage(0)
})

const top3 = (cands: Recommendation[], w: Weights) => {
  const n = normalizeWeights(w).weights
  return cands.map(r => ({ ...r, totalScore: weightedScore(r.componentScores, n) })).sort(compareRecommendations).slice(0, 3).map(r => r.area.code)
}

/** signal로 취소할 수 있다. 동네 40곳마다 화면에 차례를 넘긴다. */
export async function measureStability(snapshot: Snapshot, result: Results, signal: AbortSignal): Promise<Stability | null> {
  const base = result.recommendations.map(r => r.area.code)
  if (base.length < 2) return null
  const cands: Recommendation[] = []
  for (let i = 0; i < snapshot.areas.length; i += 40) {
    await yieldToPage()
    if (signal.aborted) return null
    for (const area of snapshot.areas.slice(i, i + 40)) {
      try { cands.push(...recommend({ ...snapshot, areas: [area] }, result.budget, result.effectiveWeights, result.locationFilter).recommendations) } catch { /* 계산할 수 없는 동네는 원래 결과에서도 빠진다 */ }
    }
  }
  // 같은 규칙으로 지금 결과가 그대로 나오는지 먼저 확인한다(다르면 표시하지 않음)
  if (top3(cands, result.effectiveWeights).join() !== base.join()) return null
  const list = variants(result.effectiveWeights)
  const names = new Map(cands.map(r => [r.area.code, r.area.name]))
  const drops: Record<string, number> = Object.fromEntries(base.map(c => [c, 0]))
  const comers = new Map<string, Map<string, number>>(base.map(c => [c, new Map()]))
  for (const w of list) {
    const alt = top3(cands, w), newcomers = alt.filter(c => !base.includes(c))
    for (const c of base) if (!alt.includes(c)) {
      drops[c]++
      const m = comers.get(c)!
      for (const n of newcomers) m.set(n, (m.get(n) ?? 0) + 1)
    }
  }
  const instead = Object.fromEntries(base.map(c => {
    const best = [...comers.get(c)!.entries()].sort((a, b) => b[1] - a[1])[0]
    return [c, best ? names.get(best[0]) ?? null : null]
  }))
  return { total: list.length, drops, instead }
}
