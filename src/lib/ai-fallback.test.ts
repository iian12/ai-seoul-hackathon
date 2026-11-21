import test from 'node:test'
import assert from 'node:assert/strict'
import { AiError, explainTop3, transcribe } from '../ui/ai.ts'
const body = { recs: [{ rank: 1, name: '사당동', district: '동작구', total: 70, scores: {}, matchCount: 10, sampleCount: 100, matchPct: 10 }] }

test('comparison uses labelled factual fallback for HTTP and network failures but preserves cancellation', async () => {
  const previous = globalThis.fetch
  try {
    for (const fetcher of [async () => { throw new TypeError('offline') }, async () => Response.json({ error: 'unavailable' }, { status: 502 })]) {
      globalThis.fetch = fetcher
      assert.equal((await explainTop3(body)).source, 'fallback')
    }
    globalThis.fetch = async () => { throw new DOMException('cancelled', 'AbortError') }
    await assert.rejects(explainTop3(body), { name: 'AbortError' })
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException('cancelled while reading', 'AbortError')) },
    }))
    await assert.rejects(explainTop3(body), { name: 'AbortError' })
  } finally { globalThis.fetch = previous }
})

test('transcription preserves the rate-limit status and text input guidance', async ({ mock }) => {
  mock.method(globalThis, 'fetch', async () => Response.json(
    { error: '잠시 후 다시 시도하거나 글로 입력해 주세요.' },
    { status: 429 },
  ))
  await assert.rejects(transcribe(new Blob(['audio'])), error =>
    error instanceof AiError && error.status === 429 && error.message.includes('글로 입력'),
  )
})
