// 앱이 말하는 중인지(또는 곧 말할 예정인지) 알려 준다. AI 비서가 앱 목소리를 듣지 않도록 듣기 전에 기다린다.
let waiting = false
let lastSpoken = ''

/** 화면 안내가 AI에게 문장을 받으러 간 동안 true */
export function setGuideWaiting(on: boolean) { waiting = on }
export function rememberSpoken(text: string) { lastSpoken = text }
export function lastSpokenText() { return lastSpoken }

const synthBusy = () => typeof window !== 'undefined' && 'speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)
export const appSpeaking = () => waiting || synthBusy()

/** 앱이 조용해질 때까지 기다린다(연속 두 번 조용해야 끝, 최대 maxMs). 먼저 minMs만큼은 무조건 기다린다. */
export async function untilQuiet(signal: AbortSignal, minMs = 700, maxMs = 25000) {
  const start = Date.now()
  let calm = 0
  while (!signal.aborted && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 150))
    if (Date.now() - start < minMs) continue
    calm = appSpeaking() ? 0 : calm + 1
    if (calm >= 3) return
  }
}

/** 한 문장을 말하고 끝날 때까지 기다린다. */
export function say(text: string): Promise<void> {
  return new Promise(resolve => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) { resolve(); return }
    const synth = window.speechSynthesis
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ko-KR'; u.rate = 0.95
    u.onend = () => resolve(); u.onerror = () => resolve()
    rememberSpoken(text)
    synth.speak(u)
  })
}

/** 듣기 시작·끝을 알리는 짧은 소리(화면을 보지 않아도 알 수 있게) */
export function beep(kind: 'start' | 'stop') {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = kind === 'start' ? 880 : 520
    g.gain.setValueAtTime(.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(.18, ctx.currentTime + .02)
    g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .16)
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + .18)
    o.onended = () => void ctx.close()
  } catch { /* 소리를 못 내도 화면 표시는 그대로 */ }
}
