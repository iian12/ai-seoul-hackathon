// 말로 찾기: 녹음한 목소리를 글로 바꾼다(Groq Whisper). 소리는 저장하지 않는다.
import { guard, HttpError, respond, transcribeAudio } from './_lib/groq.js'

export const config = { maxDuration: 30 }

const TYPES: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a' }
const MAX_BYTES = 4 * 1024 * 1024 // Vercel 함수 요청 크기 한도(4.5MB) 안쪽. 30초 안팎의 말이면 충분하다.

export async function POST(request: Request) {
  return respond(async () => {
    guard(request, 15)
    const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ext = TYPES[type]
    if (!ext) throw new HttpError(415, '이 녹음 형식은 지원하지 않아요. 글로 적어 주세요.')
    const buf = await request.arrayBuffer()
    if (!buf.byteLength) throw new HttpError(400, '녹음된 소리가 없어요. 다시 말해 주세요.')
    if (buf.byteLength > MAX_BYTES) throw new HttpError(413, '녹음이 너무 길어요. 짧게 다시 말해 주세요.')
    const text = await transcribeAudio(new Blob([buf], { type }), `voice.${ext}`)
    if (!text) throw new HttpError(422, '말을 알아듣지 못했어요. 다시 말하거나 글로 적어 주세요.')
    return { text }
  })
}
