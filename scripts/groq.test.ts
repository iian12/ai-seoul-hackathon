import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { chatJson, transcribeAudio } from '../api/_lib/groq.ts'

const chat = { system: 'system', user: 'user', name: 'test', schema: {} }
const chatReply = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
const limited = (seconds: string) => new Response('Rate limited', { status: 429, headers: { 'Retry-After': seconds } })

const originalKey = process.env.GROQ_API_KEY
const originalKeys = process.env.GROQ_API_KEYS
beforeEach(() => {
  process.env.GROQ_API_KEY = 'test-key'
  delete process.env.GROQ_API_KEYS
})
afterEach(() => {
  if (originalKey === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = originalKey
  if (originalKeys === undefined) delete process.env.GROQ_API_KEYS
  else process.env.GROQ_API_KEYS = originalKeys
})

test('chat retries a short Groq rate limit once with the same credentials and deadline', async ({ mock }) => {
  let attempts = 0
  const fetch = mock.method(globalThis, 'fetch', async (..._args: Parameters<typeof globalThis.fetch>) =>
    ++attempts === 1 ? limited('1') : chatReply(),
  )
  const start = performance.now()
  assert.deepEqual(await chatJson(chat), { ok: true })
  assert.ok(performance.now() - start >= 950, 'waits before retrying')
  assert.equal(fetch.mock.callCount(), 2)
  const first = fetch.mock.calls[0].arguments[1] as RequestInit
  const second = fetch.mock.calls[1].arguments[1] as RequestInit
  assert.equal(new Headers(first.headers).get('Authorization'), 'Bearer test-key')
  assert.equal(new Headers(second.headers).get('Authorization'), 'Bearer test-key')
  assert.equal(second.signal, first.signal)
  assert.equal(second.body, first.body)
})

test('chat returns a second 429 without retrying again', async ({ mock }) => {
  process.env.GROQ_API_KEYS = 'backup-key, unused-key'
  const fetch = mock.method(globalThis, 'fetch', async () => limited('0'))
  await assert.rejects(chatJson(chat), { status: 429 })
  assert.equal(fetch.mock.callCount(), 2)
})

test('chat returns long, missing or malformed rate-limit delays immediately', async ({ mock }) => {
  process.env.GROQ_API_KEYS = 'backup-key'
  const responses = [limited('3'), new Response(null, { status: 429 }), limited('invalid')]
  const fetch = mock.method(globalThis, 'fetch', async () => responses.shift() ?? chatReply())
  for (let count = 1; count <= 3; count++) {
    await assert.rejects(chatJson(chat), { status: 429 })
    assert.equal(fetch.mock.callCount(), count)
  }
})

test('chat disables keys that return 401 and skips them on later requests', async ({ mock }) => {
  process.env.GROQ_API_KEY = 'revoked-primary'
  process.env.GROQ_API_KEYS = ' revoked-primary, revoked-backup, , working-backup '
  const credentials: Array<string | null> = []
  mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const credential = new Headers(options.headers).get('Authorization')
    credentials.push(credential)
    return credential === 'Bearer working-backup' ? chatReply() : new Response(null, { status: 401 })
  })
  assert.deepEqual(await chatJson(chat), { ok: true })
  assert.deepEqual(await chatJson(chat), { ok: true })
  assert.deepEqual(credentials, ['Bearer revoked-primary', 'Bearer revoked-backup', 'Bearer working-backup', 'Bearer working-backup'])
})

test('chat returns an auth error when the configured keys are exhausted', async ({ mock }) => {
  delete process.env.GROQ_API_KEY
  process.env.GROQ_API_KEYS = 'invalid-only, invalid-only'
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }))
  await assert.rejects(chatJson(chat), { status: 500 })
  await assert.rejects(chatJson(chat), { status: 500 })
  assert.equal(fetch.mock.callCount(), 1)
})

test('transcription can resend a multipart body after a short Groq rate limit', async ({ mock }) => {
  process.env.GROQ_API_KEYS = 'backup-key'
  const bodies: string[] = []
  const credentials: Array<string | null> = []
  mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const form = await new Request(url, options).formData()
    const file = form.get('file') as File
    bodies.push(await file.text())
    credentials.push(new Headers(options.headers).get('Authorization'))
    assert.equal(file.name, 'voice.webm')
    return bodies.length === 1 ? limited('0') : Response.json({ text: ' 서울 ' })
  })
  assert.equal(await transcribeAudio(new Blob(['audio']), 'voice.webm'), '서울')
  assert.deepEqual(bodies, ['audio', 'audio'])
  assert.deepEqual(credentials, ['Bearer test-key', 'Bearer backup-key'])
  assert.equal(await transcribeAudio(new Blob(['audio']), 'voice.webm'), '서울')
  assert.equal(credentials.at(-1), 'Bearer test-key')
})

test('transcription suggests typing if the Groq delay is too long', async ({ mock }) => {
  const fetch = mock.method(globalThis, 'fetch', async () => limited('10'))
  await assert.rejects(transcribeAudio(new Blob(['audio']), 'voice.webm'), {
    status: 429,
    message: /글로 입력/,
  })
  assert.equal(fetch.mock.callCount(), 1)
})
