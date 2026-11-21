// "보증금 1000에 월세 60, 밤늦게 퇴근해요" 같은 말을 조건으로 바꾼다.
// 규칙 기반(서버·AI 호출 없음). 결과는 화면에 보여주고 사용자가 확인한 뒤에만 적용한다.
import type { LeaseType } from '../lib/types.ts'
import { manwonLabel } from './plain.ts'

export interface ParsedQuery {
  leaseType?: LeaseType
  deposit?: number // 만원
  rent?: number // 만원
  preset?: 'balanced' | 'safety' | 'transit' | 'housing' | 'medical' | 'policing'
  understood: string[] // 알아들은 내용(화면 표시용)
}

/** "3억 5천", "1,000", "5백" → 만원 단위 숫자 */
function toManwon(raw: string): number | undefined {
  const s = raw.replace(/[,\s]/g, '').replace(/원$/, '')
  if (!s) return undefined
  let total = 0, matched = false
  const eok = s.match(/(\d+(?:\.\d+)?)억/)
  if (eok) { total += Number(eok[1]) * 10000; matched = true }
  const rest = eok ? s.slice(s.indexOf('억') + 1) : s
  const cheon = rest.match(/(\d+(?:\.\d+)?)천/)
  if (cheon) { total += Number(cheon[1]) * 1000; matched = true }
  const baek = rest.match(/(\d+(?:\.\d+)?)백/)
  if (baek) { total += Number(baek[1]) * 100; matched = true }
  const plain = rest.replace(/\d+(?:\.\d+)?[천백]/g, '').match(/(\d+(?:\.\d+)?)만?$/)
  if (plain) { total += Number(plain[1]); matched = true }
  return matched && total > 0 ? Math.round(total) : undefined
}

const AMOUNT = '(\\d[\\d,.]*\\s*억(?:\\s*\\d[\\d,.]*\\s*천)?(?:\\s*\\d[\\d,.]*)?|\\d[\\d,.]*\\s*천(?:\\s*\\d[\\d,.]*)?|\\d[\\d,.]*\\s*백|\\d[\\d,.]*)\\s*(?:만\\s*원|만원|만)?'

const PRESET_WORDS: [ParsedQuery['preset'], RegExp, string][] = [
  ['policing', /치안|범죄|범죄율/, '자치구 범죄 통계를 중요하게'],
  ['safety', /밤|늦게|야근|귀가|안전|무서|여자\s*혼자|CCTV/i, '밤길 안전을 중요하게'],
  ['medical', /병원|약국|건강|아프|의료|진료|응급/, '병원·약국을 중요하게'],
  ['transit', /출퇴근|통학|역세권|지하철|역\s*가까|교통|버스|출근|학교\s*가까/, '교통을 중요하게'],
  ['housing', /싸|저렴|아끼|가성비|부담|절약|돈\s*없/, '주거비를 아끼는 쪽으로'],
]

export function parseQuery(text: string): ParsedQuery {
  const t = text.normalize('NFC')
  const out: ParsedQuery = { understood: [] }

  if (/전세/.test(t) && !/월세/.test(t)) out.leaseType = 'jeonse'
  else if (/월세|보증금/.test(t)) out.leaseType = 'monthly'

  const dep = t.match(new RegExp(`(?:보증금|전세금?|전세\\s*보증금)\\s*(?:은|는|이|가)?\\s*${AMOUNT}`))
  const rent = t.match(new RegExp(`(?:월세|매달|한\\s*달)\\s*(?:은|는|이|가)?\\s*${AMOUNT}`))
  if (dep) out.deposit = toManwon(dep[1])
  if (rent) out.rent = toManwon(rent[1])
  // "1000에 60", "1000/60" 같은 짧은 표현
  if (out.deposit == null && out.rent == null) {
    const pair = t.match(new RegExp(`${AMOUNT}\\s*(?:에|/|에다가|,)\\s*${AMOUNT}`))
    if (pair) { out.deposit = toManwon(pair[1]); out.rent = toManwon(pair[2]); out.leaseType ??= 'monthly' }
  }
  if (out.leaseType === 'jeonse' && out.deposit == null) {
    const any = t.match(new RegExp(AMOUNT))
    if (any) out.deposit = toManwon(any[1])
  }
  if (out.leaseType == null && (out.deposit != null || out.rent != null)) out.leaseType = 'monthly'

  const hits = PRESET_WORDS.filter(([, re]) => re.test(t))
  if (hits.length === 1) out.preset = hits[0][0]
  else if (hits.length > 1) out.preset = 'balanced'

  if (out.leaseType) out.understood.push(out.leaseType === 'jeonse' ? '전세' : '월세')
  if (out.deposit != null) out.understood.push(`${out.leaseType === 'jeonse' ? '전세 보증금' : '보증금'} ${manwonLabel(String(out.deposit))}`)
  if (out.rent != null && out.leaseType !== 'jeonse') out.understood.push(`월세 ${manwonLabel(String(out.rent))}`)
  if (hits.length === 1) out.understood.push(hits[0][2])
  else if (hits.length > 1) out.understood.push(`${hits.map(h => h[2].replace(' 중요하게', '').replace('을', '').replace('를', '')).join('·')} 골고루`)
  return out
}
