import { useEffect, useRef, useState } from 'react'
import { Accessibility, LoaderCircle, MicOff, Send, X } from 'lucide-react'
import { AiError, transcribe } from '../ui/ai.ts'
import { beep, say, untilQuiet } from '../ui/speech.ts'

// 시각장애인 안내: 한 번 누르면 화면 안내를 켜고 바로 듣는다(오른쪽 위 머리글).
// 말 → (Groq Whisper) 글 → 명령이면 화면 이동, 아니면 조건으로 찾기 → 화면 안내가 읽어 줌 → 다시 듣기.
// 앱이 말하는 동안에는 듣지 않는다(앱 목소리를 조건으로 알아듣지 않도록).

export interface AssistantReply { say?: string; off?: boolean }
type Phase = 'off' | 'greeting' | 'waiting' | 'listening' | 'stt' | 'thinking' | 'paused'
interface Props { canRecord: boolean; onOn: () => void; onOff: () => void; handle: (text: string) => Promise<AssistantReply> }

const GREETING = '시각장애인 안내를 켰어요. 화면이 바뀔 때마다 읽어 드려요. 삐 소리가 나면 원하는 조건을 말씀하세요. 예를 들어, 송파구에서 보증금 천에 월세 육십. 할 수 있는 말은 도움말이라고 하면 알려 드려요.'
const PAUSED = '듣기를 잠시 멈췄어요. 다시 말하려면 화면 오른쪽 위 시각장애인 안내 버튼을 눌러 주세요.'

/** 말이 끝나면(1.3초 조용하면) 스스로 녹음을 멈춘다. 7초 동안 말이 없으면 빈손으로 끝낸다. */
async function recordUtterance(signal: AbortSignal, stopNow: { current: boolean }): Promise<Blob | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx(), analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t))
  const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
  const chunks: Blob[] = []
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  return new Promise(resolve => {
    const buf = new Float32Array(analyser.fftSize)
    let floorSum = 0, floorN = 0, voicedMs = 0, silentMs = 0, heard = false, done = false
    const t0 = Date.now()
    const finish = () => {
      if (done) return
      done = true; window.clearInterval(timer)
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); void ctx.close()
        const blob = new Blob(chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] })
        resolve(heard && !signal.aborted && blob.size > 1200 ? blob : null)
      }
      if (rec.state === 'recording') rec.stop(); else rec.onstop?.call(rec, new Event('stop'))
    }
    const timer = window.setInterval(() => {
      if (signal.aborted) { finish(); return }
      if (stopNow.current) { heard = heard || Date.now() - t0 > 600; finish(); return }
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const rms = Math.sqrt(sum / buf.length), elapsed = Date.now() - t0
      if (elapsed < 400) { floorSum += rms; floorN++; return }
      const threshold = Math.max(.012, (floorSum / Math.max(1, floorN)) * 3)
      if (rms > threshold) { voicedMs += 100; silentMs = 0; if (voicedMs >= 200) heard = true }
      else { silentMs += 100; voicedMs = 0 }
      if ((heard && silentMs >= 1300) || (!heard && elapsed >= 7000) || elapsed >= 15000) finish()
    }, 100)
    rec.start(250)
  })
}

export default function Assistant({ canRecord, onOn, onOff, handle }: Props) {
  const [phase, setPhase] = useState<Phase>('off')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [typed, setTyped] = useState('')
  const loop = useRef<AbortController | null>(null)
  const stopNow = useRef(false)
  const handleRef = useRef(handle)
  handleRef.current = handle
  const on = phase !== 'off'

  useEffect(() => () => loop.current?.abort(), [])

  /** 한 번 처리: 글을 넘기고 답을 말한다. 끄기 명령이면 false */
  async function process(text: string, signal: AbortSignal): Promise<boolean> {
    setHeard(text); setReply(''); setPhase('thinking')
    const out = await handleRef.current(text)
    if (signal.aborted) return false
    if (out.off) { await say('시각장애인 안내를 껐어요.'); turnOff(); return false }
    if (out.say) { setReply(out.say); await say(out.say) }
    return true
  }

  /** 듣기 → 처리 → 다시 듣기. 말이 없거나 오류가 두 번 이어지면 잠시 멈춘다. */
  async function listenLoop(signal: AbortSignal) {
    let failures = 0
    while (!signal.aborted) {
      setPhase('waiting')
      await untilQuiet(signal)
      if (signal.aborted) return
      if (!canRecord) { setPhase('paused'); return }
      stopNow.current = false
      setPhase('listening'); beep('start')
      let blob: Blob | null
      try { blob = await recordUtterance(signal, stopNow) }
      catch { setReply('마이크를 쓸 수 없어요. 브라우저의 마이크 권한을 켜 주세요. 글로 적어도 돼요.'); await say('마이크를 쓸 수 없어요. 브라우저의 마이크 권한을 켜 주세요.'); setPhase('paused'); return }
      beep('stop')
      if (signal.aborted) return
      if (!blob) { setReply(PAUSED); await say(PAUSED); setPhase('paused'); return }
      setPhase('stt')
      let text = ''
      try { text = (await transcribe(blob, signal)).trim() }
      catch (e) {
        if (signal.aborted) return
        const msg = e instanceof Error ? e.message : '말을 알아듣지 못했어요.'
        if (e instanceof AiError && e.status === 429) {
          setReply(msg)
          setPhase('paused')
          await say(msg)
          return
        }
        failures++
        setReply(msg); await say(`${msg} 다시 말해 주세요.`)
        if (failures >= 2) { setPhase('paused'); return }
        continue
      }
      if (!text) { failures++; await say('잘 듣지 못했어요. 다시 말해 주세요.'); if (failures >= 2) { setPhase('paused'); return } continue }
      failures = 0
      if (!await process(text, signal)) return
    }
  }

  function start(greet: boolean) {
    loop.current?.abort()
    const c = new AbortController(); loop.current = c
    void (async () => {
      if (greet) { setPhase('greeting'); setReply(GREETING); await say(GREETING) }
      if (!c.signal.aborted) await listenLoop(c.signal)
    })()
  }
  function turnOn() { onOn(); setHeard(''); setReply(''); start(true) }
  function turnOff() { loop.current?.abort(); loop.current = null; window.speechSynthesis?.cancel(); setPhase('off'); onOff() }

  /** 큰 버튼: 꺼져 있으면 켜고, 듣는 중이면 지금 멈추고, 그 밖에는 앱 말을 끊고 바로 듣는다. */
  function press() {
    if (!on) { turnOn(); return }
    if (phase === 'listening') { stopNow.current = true; return }
    if (phase === 'stt' || phase === 'thinking') return
    window.speechSynthesis?.cancel()
    start(false)
  }
  function submitTyped(e: React.FormEvent) {
    e.preventDefault()
    const t = typed.trim()
    if (!t) return
    setTyped('')
    loop.current?.abort()
    const c = new AbortController(); loop.current = c
    window.speechSynthesis?.cancel()
    void (async () => { if (await process(t, c.signal) && !c.signal.aborted) await listenLoop(c.signal) })()
  }

  const status = phase === 'greeting' ? '안내를 읽고 있어요'
    : phase === 'waiting' ? '화면 안내를 읽는 중이에요. 끝나면 삐 소리 뒤에 말씀하세요'
    : phase === 'listening' ? '듣고 있어요. 말이 끝나면 저절로 멈춰요'
    : phase === 'stt' ? '말을 글로 바꾸는 중이에요'
    : phase === 'thinking' ? '알아듣고 처리하는 중이에요'
    : phase === 'paused' ? '듣기를 멈췄어요. 버튼을 누르면 다시 들어요' : ''
  const label = !on ? '시각장애인 안내 켜기: 화면을 읽어 주고 말로 동네를 찾아요'
    : phase === 'listening' ? '말하기 끝내기' : phase === 'stt' || phase === 'thinking' ? '시각장애인 안내가 처리하는 중' : '시각장애인 안내: 지금 말하기'

  return <div className={`assistant ${on ? 'on' : ''} ${phase}`}>
    <button type="button" id="assistant-button" className="toggle assistant-btn" aria-label={label} aria-pressed={on} onClick={press} disabled={on && (phase === 'stt' || phase === 'thinking')}>
      {phase === 'listening' ? <MicOff size={15} aria-hidden="true" /> : phase === 'stt' || phase === 'thinking' ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Accessibility size={15} aria-hidden="true" />}
      <span className="assist-text">{!on ? '시각장애인 안내' : phase === 'listening' ? '듣는 중' : '말하기'}</span>
    </button>
    {on && <section className="assistant-panel" aria-label="시각장애인 안내">
      <div className="assistant-head">
        <b>시각장애인 안내</b>
        <button type="button" className="btn btn-ghost btn-sm" onClick={turnOff}><X size={14} aria-hidden="true" />안내 끄기</button>
      </div>
      <p className="assistant-status" role="status">{(phase === 'stt' || phase === 'thinking') && <LoaderCircle className="spin" size={14} aria-hidden="true" />}{status}</p>
      {heard && <p className="assistant-heard"><span>들은 말</span>{heard}</p>}
      {reply && <p className="assistant-reply">{reply}</p>}
      <form className="assistant-type" onSubmit={submitTyped}>
        <label htmlFor="assistant-text" className="sr-only">말 대신 글로 적기</label>
        <input id="assistant-text" value={typed} onChange={e => setTyped(e.target.value)} placeholder="말 대신 글로 적어도 돼요" autoComplete="off" />
        <button type="submit" className="btn btn-icon btn-secondary" aria-label="보내기" disabled={!typed.trim()}><Send size={16} aria-hidden="true" /></button>
      </form>
      <p className="assistant-privacy">말한 소리와 문장은 AI(Groq)로 보내 글로 바꾸고 이해하는 데만 써요. 저장하지 않아요.</p>
    </section>}
  </div>
}
