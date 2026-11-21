import { createExplanation } from '../src/lib/explanation.ts'
// TOP 3 비교 설명: 이미 규칙으로 계산된 세 동네의 수치만 근거로, 사용자 상황에 맞춰 장단점을 쉬운 말로 정리한다.
// 순위·점수는 바꾸지 않는다.
import { chatJson, guard, HttpError, readJson, respond } from './_lib/groq.js'

export const config = { maxDuration: 30 }

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'areas', 'tip'],
  properties: {
    summary: { type: 'string' },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'headline', 'pros', 'cons'],
        properties: { rank: { type: 'integer' }, headline: { type: 'string' }, pros: { type: 'array', items: { type: 'string' } }, cons: { type: 'array', items: { type: 'string' } } },
      },
    },
    tip: { type: 'string' },
  },
}

const SYSTEM = `너는 서울 1인 가구 동네 추천 서비스 '서울사이'의 설명 도우미다. 규칙으로 이미 계산된 추천 동네 세 곳(또는 그보다 적게)을 사용자 조건에 맞춰 비교해 쉬운 한국어 존댓말로 설명한다.

[반드시 지킬 것]
- 아래 [데이터]에 있는 숫자와 사실만 쓴다. 없는 시설·가게·학교·분위기·치안 수준·교통 노선 이름을 지어내지 않는다.
- 순위와 점수를 바꾸거나 다시 매기지 않는다. 치안은 자치구 전체 범죄율의 상대 점수이고 안전시설 점수와 별개다. 동별 범죄율·개인 피해 확률·안전 보장으로 표현하지 않는다.
- '안전시설' 수치는 안심귀갓길에 설치된 시설(2022년 조사)의 수일 뿐이다. 실제로 안전하다는 뜻이 아니다. "안심할 수 있어요", "안전감", "안전해요", "안전한 동네", "범죄가 적어요" 같은 표현은 절대 쓰지 말고 "안심귀갓길 시설이 ○곳으로 많아요"처럼 시설 수만 말한다.
- '예산에 맞는 계약 비율'은 높을수록 좋다(내 예산으로 구할 수 있던 집이 많았다는 뜻). 낮으면 반드시 단점으로 쓰고, 낮은 것을 장점처럼 쓰지 않는다. 주거비 점수도 높을수록 좋다.
- 동네 월세 중간값이 사용자 월세 상한보다 높으면 "이 동네는 대체로 예산보다 비싼 편이에요"처럼 단점으로 쓴다.
- 시세는 지난 계약 기록이다. 지금 나와 있는 집이 있다고 말하지 않는다.
- 어려운 말(중위값, 정규화 등)은 쓰지 않는다. 금액은 "60만 원", 거리는 "걸어서 약 5분"처럼 쓴다.
[형식]
- summary: 세 동네가 서로 어떻게 다른지 보여 주는 2문장. 조건을 다시 읊지 말고 "○○동은 ~, ○○동은 ~"처럼 차이를 말한다. 사용자가 중요하게 본 것과 연결한다.
- areas: 동네마다 rank, headline(동네 이름은 빼고 그 동네의 특징을 15자 안팎으로, "최고"·"완벽"·"안심" 같은 말 없이), pros 2개, cons 1~2개. 각 항목은 숫자 하나 이상을 포함한 한 문장이며 괄호를 쓰지 않는다.
- 예산에 맞는 계약 비율이 낮으면(30% 미만) cons에 꼭 넣는다.
- tip: 사용자 상황에서 무엇을 직접 확인해 보면 좋은지 한 문장(예: 밤에 역까지 걸어 보기).`

type Num = number | null
interface RecIn { rank: number; name: string; district: string; total: number; scores: Record<string, number>; matchPct: Num; matchCount: Num; sampleCount: Num; medianRentManwon: Num; medianDepositManwon: Num; walkMin: Num; busM: Num; safety500m: Num; cctv500m: Num; hospitals500m: Num; pharmacies500m: Num; nightPharmacies1km: Num; emergencyKm: Num; distanceKm: Num }

const str = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : ''
const num = (v: unknown): Num => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null

function factLine(r: RecIn) {
  const parts = [
    `${r.rank}위 ${r.district} ${r.name} (종합 ${r.total}점)`,
    `점수: 치안 ${r.scores.policing}·안전시설 ${r.scores.safety}·교통 ${r.scores.transit}·주거비 ${r.scores.housing}·병원약국 ${r.scores.medical}`,
    r.matchPct != null ? `예산에 맞는 지난 계약 ${r.matchCount}/${r.sampleCount}건(${r.matchPct}%)` : '',
    r.medianRentManwon != null ? `동네 월세 중간값 ${r.medianRentManwon}만 원` : '',
    r.medianDepositManwon != null ? `동네 전세 보증금 중간값 ${r.medianDepositManwon}만 원` : '',
    r.walkMin != null ? `지하철역까지 걸어서 약 ${r.walkMin}분` : '',
    r.busM != null ? `버스정류장 직선 ${r.busM}m` : '',
    r.safety500m != null ? `반경 500m 안심귀갓길 시설 ${r.safety500m}곳(CCTV ${r.cctv500m ?? '?'}곳)` : '',
    r.hospitals500m != null ? `반경 500m 병·의원 ${r.hospitals500m}곳, 약국 ${r.pharmacies500m ?? '?'}곳` : '',
    r.nightPharmacies1km != null ? `반경 1km 밤 10시 넘어 여는 약국 ${r.nightPharmacies1km}곳(공시 기준)` : '',
    r.emergencyKm != null ? `응급실까지 직선 ${r.emergencyKm}km` : '',
    r.distanceKm != null ? `기준 위치에서 직선 ${r.distanceKm}km` : '',
  ]
  return '- ' + parts.filter(Boolean).join(' / ')
}

export async function POST(request: Request) {
  return respond(async () => {
    guard(request, 20)
    const body = await readJson(request, 12_000) as { conditions?: Record<string, unknown>; recs?: unknown[] }
    if (!body || typeof body !== 'object') throw new HttpError(400, '설명 요청 형식이 올바르지 않아요.')
    const c = body.conditions ?? {}
    const recs = Array.isArray(body.recs) ? body.recs.slice(0, 3).map((x): RecIn => {
      const r = (x ?? {}) as Record<string, unknown>
      const s = (r.scores ?? {}) as Record<string, unknown>
      return {
        rank: num(r.rank) ?? 0, name: str(r.name, 20), district: str(r.district, 10), total: num(r.total) ?? 0,
        scores: { policing: num(s.policing) ?? 0, safety: num(s.safety) ?? 0, transit: num(s.transit) ?? 0, housing: num(s.housing) ?? 0, medical: num(s.medical) ?? 0 },
        matchPct: num(r.matchPct), matchCount: num(r.matchCount), sampleCount: num(r.sampleCount), medianRentManwon: num(r.medianRentManwon), medianDepositManwon: num(r.medianDepositManwon),
        walkMin: num(r.walkMin), busM: num(r.busM), safety500m: num(r.safety500m), cctv500m: num(r.cctv500m), hospitals500m: num(r.hospitals500m), pharmacies500m: num(r.pharmacies500m),
        nightPharmacies1km: num(r.nightPharmacies1km), emergencyKm: num(r.emergencyKm), distanceKm: num(r.distanceKm),
      }
    }).filter(r => r.name) : []
    if (recs.some((r, i) => !r.district || r.rank !== i + 1 || r.total < 0 || r.total > 100 || r.matchPct == null || r.matchPct < 0 || r.matchPct > 100 || r.matchCount == null || r.matchCount < 10 || r.sampleCount == null || r.sampleCount < r.matchCount)) throw new HttpError(400, '추천 순위와 계약 수치를 확인해 주세요.')
    if (!recs.length) throw new HttpError(400, '설명할 추천 동네가 없어요.')
    const user = [
      '[사용자 조건]',
      `- ${str(c.budget, 60)}`,
      `- 중요하게 본 것: ${str(c.priority, 60)}`,
      c.place ? `- 기준 위치: ${str(c.place, 30)} 반경 ${num(c.radiusKm) ?? '?'}km` : '',
      c.area ? `- 비교 범위: ${str(c.area, 80)} 안의 동네만` : '',
      '[데이터]',
      ...recs.map(factLine),
    ].filter(Boolean).join('\n')
    return createExplanation(recs, () => chatJson({ system: SYSTEM, user, name: 'top3_explanation', schema: EXPLAIN_SCHEMA, maxTokens: 2500 }))
  })
}
