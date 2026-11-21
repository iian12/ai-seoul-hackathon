// 화면 안내(시각장애인·저시력 사용자용): 지금 화면에 무엇이 있고 다음에 무엇을 할 수 있는지 말로 들려줄 문장을 만든다.
// 화면이 넘겨준 사실과 버튼 이름만 쓴다.
import { chatJson, guard, HttpError, readJson, respond } from './_lib/groq.js'

export const config = { maxDuration: 30 }

const GUIDE_SCHEMA = { type: 'object', additionalProperties: false, required: ['speech'], properties: { speech: { type: 'string' } } }

const SYSTEM = `너는 서울 1인 가구 동네 추천 서비스 '서울사이'의 화면 안내 도우미다. 화면을 보기 어려운 사용자에게 지금 화면을 소리로 안내할 문장을 만든다.

[규칙]
- [화면 정보]에 있는 사실만 말한다. 없는 버튼·숫자·장소를 지어내지 않는다.
- 첫 문장은 "지금은 ○○ 화면이에요."로 시작한다.
- 중요한 내용 2~4문장, 마지막에 "다음에 할 수 있는 일"을 [버튼] 목록의 이름 그대로 1~3개 말한다. 버튼 이름은 작은따옴표로 감싼다.
- 지도 위치는 [화면 정보]에 있는 방향·거리 표현만 쓴다.
- 짧은 문장, 쉬운 말, 존댓말. 전체 7문장 이하. 특수기호·이모지·괄호 설명을 쓰지 않는다(소리로 읽기 때문).`

const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : ''

export async function POST(request: Request) {
  return respond(async () => {
    guard(request, 30)
    const body = await readJson(request, 6000) as { screen?: unknown; facts?: unknown; actions?: unknown }
    const screen = clean(body.screen, 30)
    const facts = Array.isArray(body.facts) ? body.facts.slice(0, 14).map(f => clean(f, 160)).filter(Boolean) : []
    const actions = Array.isArray(body.actions) ? body.actions.slice(0, 8).map(a => clean(a, 40)).filter(Boolean) : []
    if (!screen) throw new HttpError(400, '안내할 화면 정보가 없어요.')
    const user = [`[화면] ${screen}`, '[화면 정보]', ...facts.map(f => `- ${f}`), '[버튼]', ...actions.map(a => `- ${a}`)].join('\n')
    return chatJson({ system: SYSTEM, user, name: 'screen_guide', schema: GUIDE_SCHEMA, maxTokens: 1200 })
  })
}
