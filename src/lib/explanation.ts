export interface Explanation { summary: string; areas: { rank: number; headline: string; pros: string[]; cons: string[] }[]; tip: string; source?: 'ai' | 'fallback'; notice?: string }
export interface ExplanationFact {
  rank: number; name: string; district: string; total: number; scores: Record<string, number>
  matchCount?: number | null; sampleCount?: number | null; matchPct?: number | null
  medianRentManwon?: number | null; medianDepositManwon?: number | null
  walkMin?: number | null; busM?: number | null; safety500m?: number | null; cctv500m?: number | null
  hospitals500m?: number | null; pharmacies500m?: number | null; nightPharmacies1km?: number | null
  emergencyKm?: number | null; distanceKm?: number | null
}
const forbidden = /최고|완벽|안심할|안전한\s*동네|안전해요|범죄가\s*적|범죄\s*위험이\s*낮|치안이\s*(좋|우수)|안전시설이\s*우수|안전(?:합니다|하다|하다고|한\s*(?:지역|곳|환경))|안심(?:해|하셔|하세)|(?:범죄(?:율|위험|발생률)|치안)[^.!?\n]{0,20}(?:낮|적|좋|우수|없)/
const numbers = (text: string) => (text.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
function numericFacts(facts: ExplanationFact[]): Set<number> {
  const result = new Set<number>()
  const visit = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) result.add(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(visit)
  }
  facts.forEach(visit)
  // Names can legitimately contain numbers (e.g. 종로1가).
  facts.forEach(f => numbers(f.name).forEach(n => result.add(n)))
  return result
}
function grounded(text: string, facts: ExplanationFact[]) {
  if (!text.trim() || text.length > 1200 || forbidden.test(text)) return false
  const scoreChecks: [RegExp, (f: ExplanationFact) => number | undefined][] = [
    [/교통[^.!?\n]{0,12}?(\d+(?:\.\d+)?)\s*점/g, f => f.scores.transit],
    [/치안[^.!?\n]{0,12}?(\d+(?:\.\d+)?)\s*점/g, f => f.scores.policing],
    [/안전시설[^.!?\n]{0,12}?(\d+(?:\.\d+)?)\s*점/g, f => f.scores.safety],
    [/(?:의료|병원·약국)[^.!?\n]{0,12}?(\d+(?:\.\d+)?)\s*점/g, f => f.scores.medical],
    [/종합[^.!?\n]{0,12}?(\d+(?:\.\d+)?)\s*점/g, f => f.total],
  ]
  for (const [pattern, expected] of scoreChecks) for (const match of text.matchAll(pattern)) if (!facts.some(f => expected(f) === Number(match[1]))) return false
  // Units belong to specific facts: an 80-point score is never evidence for 80만원.
  const clean = text.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1')
  const quantity = /([+−-]?\s*\d+(?:\.\d+)?)\s*(만\s*원|원|%|건|곳|지점|개|분|km|킬로미터|m|미터)/g
  for (const m of clean.matchAll(quantity)) {
    const value = Number(m[1].replace(/\s/g, '').replace('−', '-')), unit = m[2].replace(/\s/g, '')
    const prefix = clean.slice(Math.max(0, m.index! - 30), m.index)
    const allowed = new Set<number>()
    const add = (v: number | null | undefined) => { if (v != null && Number.isFinite(v)) allowed.add(v) }
    for (const f of facts) {
      if (unit === '만원' || unit === '원') {
        const amount = prefix.lastIndexOf('월세') > prefix.lastIndexOf('보증금') ? f.medianRentManwon : prefix.includes('보증금') ? f.medianDepositManwon : undefined
        add(amount == null ? undefined : amount * (unit === '원' ? 10000 : 1))
      } else if (unit === '%') add(f.matchPct)
      else if (unit === '건') {
        const matchAt = Math.max(prefix.lastIndexOf('예산'), prefix.lastIndexOf('충족'), prefix.lastIndexOf('적합'))
        const totalAt = Math.max(prefix.lastIndexOf('전체'), prefix.lastIndexOf('총'), prefix.lastIndexOf('표본'))
        const fraction = prefix.match(/(\d+)\s*(?:건)?\s*\/\s*$/)
        if (fraction && Number(fraction[1]) === f.matchCount) add(f.sampleCount)
        else if (matchAt > totalAt) add(f.matchCount)
        else if (totalAt >= 0) add(f.sampleCount)
      }
      else if (unit === '분') add(f.walkMin)
      else if (['곳', '지점', '개'].includes(unit)) {
        const v = /CCTV|씨씨티비/i.test(prefix) ? f.cctv500m : /안전시설|안심귀갓길/.test(prefix) ? f.safety500m : /야간|밤|심야/.test(prefix) ? f.nightPharmacies1km : /약국/.test(prefix) ? f.pharmacies500m : /병|의원/.test(prefix) ? f.hospitals500m : undefined
        add(v)
      } else {
        const km = unit === 'km' || unit === '킬로미터'
        const d = /응급/.test(prefix) ? (f.emergencyKm == null ? undefined : f.emergencyKm * 1000) : /버스|정류/.test(prefix) ? f.busM : /기준 위치|반경/.test(prefix) ? (f.distanceKm == null ? undefined : f.distanceKm * 1000) : undefined
        add(d == null ? undefined : d / (km ? 1000 : 1))
      }
    }
    if (!allowed.has(value)) return false
  }
  const allowed = numericFacts(facts)
  if (numbers(clean.replace(quantity, ' ')).some(n => !allowed.has(n))) return false
  const places = text.match(/[가-힣0-9·]+(?:동|구)(?=[은는이가을를에의과와\s,.·]|$)/g) ?? []
  return places.every(p => facts.some(f => f.name === p || f.district === p))
}
export function validateExplanation(value: unknown, facts: ExplanationFact[]): value is Explanation {
  if (!value || typeof value !== 'object') return false
  const e = value as Explanation
  if (typeof e.summary !== 'string' || typeof e.tip !== 'string' || !grounded(e.summary, facts) || !grounded(e.tip, facts) || !Array.isArray(e.areas) || e.areas.length !== facts.length) return false
  const ranks = new Set<number>()
  for (const a of e.areas) {
    const fact = facts.find(f => f.rank === a?.rank)
    if (!fact || ranks.has(a.rank) || typeof a.headline !== 'string' || !Array.isArray(a.pros) || !a.pros.length || !Array.isArray(a.cons) || !a.cons.length || ![a.headline, ...a.pros, ...a.cons].every(t => typeof t === 'string' && grounded(t, [fact]))) return false
    if ((fact.matchPct ?? 100) < 30 && !a.cons.some(t => /예산/.test(t) && /비율|%|계약/.test(t))) return false
    ranks.add(a.rank)
  }
  return true
}
export function factualExplanation(facts: ExplanationFact[]): Explanation {
  return {
    source: 'fallback', notice: 'AI 설명을 검증하지 못해 집계 수치로 만든 기본 설명을 보여드려요.',
    summary: '예산에 맞는 과거 계약과 동네의 상대 점수를 함께 비교해 주세요. 과거 계약은 현재 매물이나 실제 안전 수준을 보장하지 않아요.',
    areas: facts.map(f => ({
      rank: f.rank, headline: '예산 적합 비율 확인',
      pros: [`예산에 맞는 과거 계약은 ${f.matchCount ?? 0}건이에요.`, `종합 상대 점수는 ${f.total}점이에요.`],
      cons: [`예산에 맞는 계약 비율은 ${f.matchPct ?? 0}%${(f.matchPct ?? 0) < 30 ? '로 낮은 편' : ''}이에요.`, '실제 매물의 가격과 상태는 별도로 확인해야 해요.'],
    })),
    tip: '관심 있는 집의 실제 계약 조건과 주변 시설을 직접 확인해 주세요.',
  }
}
export async function createExplanation(facts: ExplanationFact[], generate: () => Promise<unknown>): Promise<Explanation> {
  try {
    const value = await generate()
    if (validateExplanation(value, facts)) return { summary: value.summary, areas: value.areas, tip: value.tip, source: 'ai' }
  } catch { /* Provider/configuration errors have the same grounded fallback. */ }
  return factualExplanation(facts)
}
