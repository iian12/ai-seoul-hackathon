// Groq 호출 공통 부분. API 키는 서버(Vercel 환경변수 GROQ_API_KEY)에만 있고 브라우저로 나가지 않는다.
// 점수·순위 계산은 하지 않는다. AI는 '말 이해'와 '설명'에만 쓴다.
const GROQ = 'https://api.groq.com/openai/v1'
export const CHAT_MODEL = 'openai/gpt-oss-120b'
export const STT_MODEL = 'whisper-large-v3-turbo'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function apiKey() {
  const k = process.env.GROQ_API_KEY
  if (!k) throw new HttpError(500, 'AI 키가 설정되지 않았어요. 관리자에게 알려 주세요.')
  return k
}

// 함수 인스턴스 하나 안에서만 세는 간단한 요청 제한(분당). 남용을 줄이는 용도이며 완전한 차단은 아니다.
const hits = new Map<string, number[]>()
export function guard(request: Request, perMinute = 20) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (origin && host) {
    let originHost = ''
    try { originHost = new URL(origin).host } catch { /* 잘못된 origin */ }
    if (originHost !== host) throw new HttpError(403, '허용되지 않은 요청이에요.')
  }
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local'
  const now = Date.now()
  const list = (hits.get(ip) ?? []).filter(t => now - t < 60_000)
  list.push(now); hits.set(ip, list)
  if (list.length > perMinute) throw new HttpError(429, '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.')
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text()
  if (text.length > maxBytes) throw new HttpError(413, '보낸 내용이 너무 길어요.')
  try { return JSON.parse(text) } catch { throw new HttpError(400, '요청 형식이 올바르지 않아요.') }
}

function upstreamError(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(500, 'AI 키를 확인해 주세요.')
  if (status === 429) return new HttpError(429, 'AI 사용량이 잠시 몰렸어요. 조금 뒤에 다시 시도해 주세요.')
  if (status === 400 || status === 422) return new HttpError(422, 'AI가 이 내용을 정리하지 못했어요. 금액이나 상황을 넣어 다시 말해 주세요.')
  return new HttpError(502, 'AI가 지금 응답하지 않아요. 잠시 후 다시 시도해 주세요.')
}

/** JSON 스키마를 반드시 지키는 응답(Structured Outputs, strict)을 받는다. */
export async function chatJson<T>(opts: { system: string; user: string; name: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0.1,
        reasoning_effort: 'low',
        include_reasoning: false,
        max_completion_tokens: opts.maxTokens ?? 2000,
        response_format: { type: 'json_schema', json_schema: { name: opts.name, strict: true, schema: opts.schema } },
        messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
      }),
    })
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(504, 'AI 응답이 너무 늦어요. 잠시 후 다시 시도해 주세요.')
  }
  if (!res.ok) throw upstreamError(res.status)
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new HttpError(502, 'AI가 빈 답을 보냈어요. 다시 시도해 주세요.')
  try { return JSON.parse(content) as T } catch { throw new HttpError(502, 'AI 답을 읽지 못했어요. 다시 시도해 주세요.') }
}

/** 녹음한 소리를 글로 바꾼다(Whisper). */
export async function transcribeAudio(audio: Blob, filename: string): Promise<string> {
  const form = new FormData()
  form.append('file', audio, filename)
  form.append('model', STT_MODEL)
  form.append('language', 'ko')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  let res: Response
  try {
    res = await fetch(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal: AbortSignal.timeout(25_000) })
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(504, '음성을 글로 바꾸는 데 너무 오래 걸려요. 다시 말해 주세요.')
  }
  if (!res.ok) throw upstreamError(res.status)
  const data = await res.json() as { text?: string }
  return (data.text ?? '').trim()
}

/** 오류는 사용자에게 보여 줄 짧은 문장으로만 돌려준다. 사용자가 보낸 내용은 기록하지 않는다. */
export async function respond(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    const message = e instanceof HttpError ? e.message : 'AI 기능에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
    return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra })
export const schema = { nullable }
