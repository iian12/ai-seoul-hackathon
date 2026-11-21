import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Ambulance, ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, Contrast, Crosshair, Keyboard, LoaderCircle, Mic, Star, X, Bus, Check, ChevronDown, CircleHelp, Database, HeartPulse, House, Info, ListChecks, MapPin, Moon, Pill, RotateCcw, Scale, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Square, TrainFront, Undo2, Volume2, Wallet } from 'lucide-react'
import { demoSnapshot } from './lib/demo.ts'
import { loadLocalSnapshot } from './lib/load-local-snapshot.ts'
import { DEFAULT_WEIGHTS, normalizeWeights, parseBudget, presets, recommend, validateSnapshot, weightedMedian } from './lib/recommend.ts'
import { loadSnapshot, supabaseConfigured } from './lib/supabase.ts'
import { domains } from './lib/types.ts'
import type { Area, Budget, Domain, LeaseType, LocationFilter, Recommendation, RecommendationOrder, Results, Snapshot, Weights } from './lib/types.ts'
import { distanceM, withinRadius } from './lib/location.ts'
import LocationPicker from './components/LocationPicker'
import ScoreBars from './components/ScoreBars'
import AreaSearch from './components/AreaSearch'
import HeroMap from './components/HeroMap'
import DistrictPicker from './components/DistrictPicker'
import Assistant from './components/Assistant'
import type { AssistantReply } from './components/Assistant'
import { lastSpokenText, rememberSpoken, setGuideWaiting } from './ui/speech.ts'
import { districtLabel, toDistrict } from './ui/districts.ts'
import PointCheck from './components/PointCheck'
import type { CheckedPoint } from './components/PointCheck'
import { areaAt } from './ui/pointCheck.ts'
import { measureStability, SHIFT } from './ui/stability.ts'
import type { Stability } from './ui/stability.ts'
import { explainTop3, fromCityHall, guideScreen, parseConditions, resolveAiLocation, transcribe } from './ui/ai.ts'
import type { Explanation } from './ui/ai.ts'
import { findStationPlace, rankPlaces } from './ui/placeSearch.ts'
import type { Place } from './lib/location.ts'

// 무거운 화면 조각은 따로 불러온다(첫 화면 3D 모형, 검색 화면 지도) — 메인 파일을 가볍게
const HeroScene = lazy(() => import('./components/HeroScene'))
const SeoulMap = lazy(() => import('./components/SeoulMap'))
import { cardFacts, emphasisOf, uiOrder, cleanNumber, fitLines, krwLabel, levelOf, levels, lifeFacts, manwonLabel, oneInTen, plainReason, presetLabel, reasonFor, reasonShort, reasonTitles, strengthsOf, walkMinutes, weightHints, weightLabels } from './ui/plain.ts'
import type { ReasonKey } from './ui/plain.ts'

type DataState = 'loading' | 'ready' | 'demo'
type FieldError = { field: 'deposit' | 'rent'; message: string }
type FieldErrors = Partial<Record<'deposit' | 'rent', string>>
interface Inputs { leaseType: LeaseType; deposit: string; jeonseDeposit: string; rent: string; weights: Weights; location?: LocationFilter; radiusKm: number; districts?: string[] }
interface ExcludedItem { area: Area; text: string; count?: string }
interface ComputeInput { leaseType: LeaseType; deposit: string; rent: string; weights: Weights; locationFilter?: LocationFilter; districts?: string[] }

const icons = { policing: ShieldCheck, safety: ShieldCheck, transit: TrainFront, housing: House, medical: HeartPulse }
const factIcons: Record<string, typeof Info> = { crime: ShieldCheck, walk: TrainFront, bus: Bus, safety: ShieldCheck, medical: Pill, night: Moon, emergency: Ambulance }
const date = (value: string) => /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).replaceAll('-', '.') : value
const noRecommendations: Results['recommendations'] = []
const noAreas: Area[] = []
const SEOUL_HOUSING_HELP = 'https://news.seoul.go.kr/welfare/archives/549525'
const COMFORT_KEY = 'seoulsai-comfort'
const CONTRAST_KEY = 'seoulsai-contrast'
type VoiceBusy = '' | 'listen' | 'stt' | 'parse'
// 말로 찾기 녹음: 브라우저가 녹음을 지원하면 마이크 버튼을 보여 준다(크롬·사파리·파이어폭스·휴대폰).
const canRecord = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
type ExplainState = { key: string; status: 'loading' | 'done' | 'error'; data?: Explanation; error?: string }
// 학교·회사 이름 목록(용량이 큼)은 말로 찾기에서 장소를 말했을 때만 한 번 받는다.
let placeIndex: Promise<Place[]> | null = null
function loadPlaces(): Promise<Place[]> {
  placeIndex ??= fetch('/data/seoul-places.json').then(r => { if (!r.ok) throw new Error('missing'); return r.json() })
    .then((d: { places?: unknown }) => Array.isArray(d.places) ? d.places as Place[] : [])
    .catch(() => { placeIndex = null; return [] })
  return placeIndex
}
const metric = (a: Area, key: string) => a.metrics?.[key]

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(demoSnapshot)
  const [dataState, setDataState] = useState<DataState>('loading')
  const [deposit, setDeposit] = useState('')
  const [leaseType, setLeaseType] = useState<LeaseType>('monthly')
  const [jeonseDeposit, setJeonseDeposit] = useState('')
  const jeonse = leaseType === 'jeonse'
  const activeDeposit = jeonse ? jeonseDeposit : deposit
  const setActiveDeposit = jeonse ? setJeonseDeposit : setDeposit
  const [rent, setRent] = useState('')
  const [weights, setWeights] = useState<Weights>({ ...DEFAULT_WEIGHTS })
  const [showCustom, setShowCustom] = useState(false)
  const [order, setOrder] = useState<RecommendationOrder>('score')
  const [result, setResult] = useState<Results | null>(null)
  const [autoMode, setAutoMode] = useState(false)
  const [prevRanks, setPrevRanks] = useState<Map<string, number> | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [recentCodes, setRecentCodes] = useState<string[]>([])
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingNote, setPendingNote] = useState('')
  const [announce, setAnnounce] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadedRemote, setLoadedRemote] = useState(false)
  const [loadedLocal, setLoadedLocal] = useState(false)
  const [comfort, setComfort] = useState(() => { try { return localStorage.getItem(COMFORT_KEY) === '1' } catch { return false } })
  const [showData, setShowData] = useState(false)
  const [location, setLocation] = useState<LocationFilter>()
  const [radiusKm, setRadiusKm] = useState(3)
  const [pickingLocation, setPickingLocation] = useState(false)
  // 위치 찍어 보기: 켜면 지도 클릭이 그 자리 점검이 된다. 왼쪽 패널은 점검 결과로 바뀐다.
  const [checking, setChecking] = useState(false)
  const [checkPoint, setCheckPoint] = useState<CheckedPoint | null>(null)
  const [showLocation, setShowLocation] = useState(false)
  // 구 단위로 좁히기(여러 구 가능). 고른 구 안의 동네만 비교한다.
  const [districts, setDistricts] = useState<string[]>([])
  const [undo, setUndo] = useState<Inputs | null>(null)
  const [speaking, setSpeaking] = useState(false)
  // 화면은 두 장: 첫 화면(home)과 찾기 화면(search). 스크롤이 아니라 눌러서 넘어간다.
  const [view, setView] = useState<'home' | 'search'>(() => /[?&](d|view)=/.test(window.location.search) ? 'search' : 'home')
  const [editing, setEditing] = useState(true)
  const [contrast, setContrast] = useState(() => { try { return localStorage.getItem(CONTRAST_KEY) === '1' } catch { return false } })
  const [startMode, setStartMode] = useState<'type' | 'voice'>('type')
  const [voiceText, setVoiceText] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [voiceBusy, setVoiceBusy] = useState<VoiceBusy>('')
  const recorder = useRef<MediaRecorder | null>(null)
  const recordTimer = useRef(0)
  // 시각장애인 안내: 켜는 동안 화면 안내도 켠다(끄면 다시 끈다)
  const assistantOn = useRef(false)
  const [explain, setExplain] = useState<ExplainState | null>(null)
  const [guide, setGuide] = useState(false)
  // 3D 서울 모형은 넓은 화면에서만 쓴다. 휴대폰(900px 이하)이나 3D를 그릴 수 없을 때는 평면 지도.
  const narrowQuery = '(max-width: 900px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(narrowQuery).matches)
  useEffect(() => { const mq = window.matchMedia(narrowQuery); const on = () => setNarrow(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on) }, [])
  const [sceneFailed, setSceneFailed] = useState(false)
  const flatMap = narrow || sceneFailed
  const voiceAbort = useRef<AbortController | null>(null)
  const listScroll = useRef(0)
  const urlApplied = useRef(false)
  const locationFilter = useMemo(() => location ? { ...location, radiusKm } : undefined, [location, radiusKm])
  const currentLocation = useRef({ filter: locationFilter, radiusKm })
  useEffect(() => { currentLocation.current = { filter: locationFilter, radiusKm } }, [locationFilter, radiusKm])
  /** 고른 구 안의 동네만 담은 스냅샷(계산 규칙은 그대로, 비교 대상만 줄인다) */
  const scoped = (ds?: string[]) => ds && ds.length ? { ...snapshot, areas: snapshot.areas.filter(a => ds.includes(a.district)) } : snapshot
  const scopedSnapshot = useMemo(() => scoped(districts), [snapshot, districts]) // eslint-disable-line react-hooks/exhaustive-deps
  const nearbyAreas = useMemo(() => locationFilter ? scopedSnapshot.areas.filter(a => withinRadius(a, locationFilter)) : scopedSnapshot.areas, [scopedSnapshot, locationFilter])
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const depositInput = useRef<HTMLInputElement>(null)
  const rentInput = useRef<HTMLInputElement>(null)
  const listPanel = useRef<HTMLElement>(null)
  const requestController = useRef<AbortController | null>(null)
  const remoteRequested = useRef(false)
  const lastKey = useRef('')
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

  // 크게 보기(글자 크기·대비) 상태는 저장해 두고 다시 와도 유지한다.
  useEffect(() => {
    document.documentElement.classList.toggle('comfort', comfort)
    try { localStorage.setItem(COMFORT_KEY, comfort ? '1' : '0') } catch { /* 저장할 수 없는 환경 */ }
  }, [comfort])
  useEffect(() => {
    document.documentElement.classList.toggle('contrast', contrast)
    try { localStorage.setItem(CONTRAST_KEY, contrast ? '1' : '0') } catch { /* 저장할 수 없는 환경 */ }
  }, [contrast])
  // 브라우저 뒤로가기로 첫 화면 ↔ 찾기 화면을 오간다.
  useEffect(() => {
    const onPop = () => setView(/[?&](d|view)=/.test(window.location.search) ? 'search' : 'home')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // 예전 '화면 안내' 버튼 설정은 쓰지 않는다(시각장애인 안내를 켤 때만 화면 안내가 켜진다).
  useEffect(() => { try { localStorage.removeItem('seoulsai-guide') } catch { /* 저장할 수 없는 환경 */ } }, [])
  useEffect(() => {
    if (!guide && canSpeak) window.speechSynthesis.cancel()
  }, [guide, canSpeak])
  useEffect(() => () => { requestController.current?.abort(); voiceAbort.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); if (canSpeak) window.speechSynthesis.cancel() }, [canSpeak])
  // 실제 서울 데이터를 받는 동안에는 "불러오는 중"으로 두고 찾기 버튼을 잠근다. 가상 데이터로 추천되는 일을 막는다.
  useEffect(() => {
    const controller = new AbortController()
    loadLocalSnapshot(controller.signal).then(async next => {
      validateSnapshot(next)
      if (!controller.signal.aborted) { setSnapshot(next); setLoadedLocal(true); setResult(null); setAutoMode(false); setSelected(null); setDataState('ready') }
    }).catch(() => { if (!controller.signal.aborted) setDataState('demo') })
    return () => controller.abort()
  }, [])

  const stats = useMemo(() => {
    const rents: { value: number; count: number }[] = [], deposits: { value: number; count: number }[] = [], jeonses: { value: number; count: number }[] = []
    let monthly = 0, jeonseCount = 0
    for (const a of snapshot.areas) {
      for (const g of a.rentalGroups ?? []) { rents.push({ value: g.monthlyRentKrw, count: g.count }); deposits.push({ value: g.depositKrw, count: g.count }); monthly += g.count }
      for (const g of a.jeonseGroups ?? []) { jeonses.push({ value: g.depositKrw, count: g.count }); jeonseCount += g.count }
    }
    return {
      total: monthly + jeonseCount,
      rent: rents.length ? weightedMedian(rents) : null,
      deposit: deposits.length ? weightedMedian(deposits) : null,
      jeonse: jeonses.length ? weightedMedian(jeonses) : null,
    }
  }, [snapshot])

  const normalized = normalizeWeights(weights)
  const preset = presets.find(p => domains.every(k => p.weights[k] === weights[k]))?.id ?? 'custom'
  const stale = Date.now() - Date.parse(snapshot.createdAt) > 45 * 86400000
  const selectedArea = snapshot.areas.find(a => a.code === selected)
  const selectedRec = result?.recommendations.find(r => r.area.code === selected)
  const recentAreas = recentCodes.map(c => snapshot.areas.find(a => a.code === c)).filter((a): a is Area => !!a)
  const resultJeonse = result?.budget.leaseType === 'jeonse'
  const extraWarnings = result ? result.warnings.filter(w => !snapshot.warnings.includes(w) && !w.startsWith('체험 데이터')) : []
  const excludedGroups = useMemo(() => {
    const groups = new Map<ReasonKey, ExcludedItem[]>()
    for (const e of result?.excluded ?? []) {
      const p = plainReason(e.reason)
      const list = groups.get(p.key) ?? []
      list.push({ area: e.area, text: p.text, count: e.reason.match(/충족 (\d+)건/)?.[1] }); groups.set(p.key, list)
    }
    return [...groups.entries()]
  }, [result])
  const explorerNote = !selectedArea || selectedRec ? '' : !result
    ? '예산을 넣고 찾기를 누르면 이 동네가 내 조건에 맞는지도 알려드려요.'
    : (() => {
      const ex = result.excluded.find(e => e.area.code === selectedArea.code)
      return ex ? `이 동네는 TOP 3 비교에서 빠졌어요. ${plainReason(ex.reason).text}.` : '이 동네는 내 조건에 맞지만 상위 3곳에는 들지 못했어요.'
    })()

  function compute(input: ComputeInput, validate: boolean): { result?: Results; fieldError?: FieldError; error?: string } {
    const d = cleanNumber(input.deposit), r = cleanNumber(input.rent)
    const isJeonse = input.leaseType === 'jeonse'
    if (!/^\d+$/.test(d)) return { fieldError: { field: 'deposit', message: isJeonse ? '최대 전세 보증금을 만원 단위 숫자로 적어 주세요. (예: 30000 → 3억 원)' : '최대 보증금을 만원 단위 숫자로 적어 주세요. (예: 1000 → 1,000만 원)' } }
    if (!isJeonse && !/^\d+$/.test(r)) return { fieldError: { field: 'rent', message: '최대 월세를 만원 단위 숫자로 적어 주세요. (예: 65 → 65만 원)' } }
    let budget: Budget
    try { budget = parseBudget(d, isJeonse ? '0' : r, input.leaseType) }
    catch { return { fieldError: { field: Number(d) > 1_000_000 ? 'deposit' : 'rent', message: '금액이 너무 커요. 숫자를 다시 확인해 주세요.' } } }
    try {
      if (validate) validateSnapshot(snapshot)
      return { result: recommend(scoped(input.districts), budget, input.weights, input.locationFilter, order) }
    } catch (e) { return { error: e instanceof Error ? e.message : '조건을 확인해 주세요.' } }
  }
  /** 제출할 때는 비어 있거나 잘못된 칸을 한 번에 모두 알려준다. */
  function validateAll(input: ComputeInput): FieldErrors {
    const d = cleanNumber(input.deposit), r = cleanNumber(input.rent)
    const isJeonse = input.leaseType === 'jeonse'
    const errs: FieldErrors = {}
    if (!/^\d+$/.test(d)) errs.deposit = isJeonse ? '최대 전세 보증금을 만원 단위 숫자로 적어 주세요. (예: 30000 → 3억 원)' : '최대 보증금을 만원 단위 숫자로 적어 주세요. (예: 1000 → 1,000만 원)'
    if (!isJeonse && !/^\d+$/.test(r)) errs.rent = '최대 월세를 만원 단위 숫자로 적어 주세요. (예: 65 → 65만 원)'
    if (!errs.deposit && !errs.rent) {
      try { parseBudget(d, isJeonse ? '0' : r, input.leaseType) }
      catch { errs[Number(d) > 1_000_000 ? 'deposit' : 'rent'] = '금액이 너무 커요. 숫자를 다시 확인해 주세요.' }
    }
    return errs
  }
  const keyOf = (input: ComputeInput) => JSON.stringify([input.leaseType, cleanNumber(input.deposit), cleanNumber(input.rent), input.weights, input.locationFilter ?? null, input.districts ?? [], snapshot.id])

  function apply(next: Results, mode: 'manual' | 'auto') {
    setPrevRanks(mode === 'auto' && result && result.budget.leaseType === next.budget.leaseType ? new Map(result.recommendations.map(r => [r.area.code, r.rank])) : null)
    setSelected(s => {
      if (mode === 'manual' || !s) return null
      const wasCard = result?.recommendations.some(r => r.area.code === s)
      return !wasCard || next.recommendations.some(r => r.area.code === s) ? s : null
    })
    setResult(next); setAutoMode(true); setPendingNote('')
    const top = next.recommendations[0]
    setAnnounce(top ? `추천 동네 ${next.recommendations.length}곳을 찾았어요. 1위는 ${top.area.district} ${top.area.name}입니다.` : '조건에 맞는 동네를 찾지 못했어요.')
    if (canSpeak && speaking) { window.speechSynthesis.cancel(); setSpeaking(false) }
  }

  /** 왼쪽 목록이 따로 스크롤되는 넓은 화면에서는 목록 안에서, 좁은 화면에서는 페이지에서 대상을 보여준다. */
  function reveal(el: HTMLElement | null, smooth = true) {
    if (!el) return
    const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto'
    const panel = listPanel.current
    if (panel && panel.contains(el) && getComputedStyle(panel).overflowY === 'auto') panel.scrollTo({ top: panel.scrollTop + el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12, behavior })
    else el.scrollIntoView({ behavior, block: 'start' })
  }
  function goSearch() {
    if (view === 'search') return
    setView('search')
    window.history.pushState({ v: 'search' }, '', /[?&]d=/.test(window.location.search) ? window.location.search : '?view=search')
  }
  function goHome() {
    setView('home'); setPickingLocation(false); setChecking(false); setCheckPoint(null)
    window.history.pushState({ v: 'home' }, '', window.location.pathname)
  }

  /** 입력값으로 추천을 계산한다. 첫 화면에서 눌렀으면 찾기 화면으로 넘어간다. */
  function runWith(input: ComputeInput, from: 'panel' | 'hero') {
    setError(''); setFieldErrors({}); setNotice(''); setUndo(null)
    const errs = validateAll(input)
    if (errs.deposit || errs.rent) {
      setFieldErrors(errs); setEditing(true)
      if (from === 'hero') goSearch()
      window.setTimeout(() => (errs.deposit ? depositInput : rentInput).current?.focus(), from === 'hero' ? 60 : 0)
      return
    }
    const out = compute(input, true)
    if (out.fieldError) { setFieldErrors({ [out.fieldError.field]: out.fieldError.message }); setEditing(true); if (from === 'hero') goSearch(); return }
    if (!out.result) { setError(out.error ?? '조건을 확인해 주세요.'); setEditing(true); if (from === 'hero') goSearch(); return }
    lastKey.current = keyOf(input)
    apply(out.result, 'manual')
    setEditing(false); setSelected(null)
    if (normalizeWeights(input.weights).reset) setNotice('모든 중요도가 0이어서 골고루 비교했어요.')
    if (from === 'hero') goSearch()
    window.setTimeout(() => { listPanel.current?.scrollTo({ top: 0 }); resultHeading.current?.focus({ preventScroll: true }) }, 60)
  }
  function runRecommendation(event: React.FormEvent, from: 'panel' | 'hero' = 'panel') {
    event.preventDefault()
    runWith({ leaseType, deposit: activeDeposit, rent, weights, locationFilter, districts }, from)
  }

  /** 말로 찾기: AI가 문장을 조건으로 바꾸면 입력칸에 채우고 바로 찾는다. 빠진 값은 결과 화면 입력칸에서 고치게 한다. */
  async function runVoiceText(text: string): Promise<string | null> {
    const t = text.trim()
    if (!t) return '조건을 말해 주세요.'
    voiceAbort.current?.abort()
    const c = new AbortController(); voiceAbort.current = c
    try {
      const q = await parseConditions(t, c.signal)
      if (c.signal.aborted) return null
      const lt = q.leaseType ?? leaseType
      const dep = q.deposit != null ? String(q.deposit) : lt === 'jeonse' ? jeonseDeposit : deposit
      const rn = lt === 'jeonse' ? '' : q.rent != null ? String(q.rent) : rent
      const w = q.weights ?? weights
      let hit: Place | undefined
      if (q.place) {
        hit = findStationPlace(q.place)
        if (!hit) {
          const index: Place[] = [...snapshot.areas.map(a => ({ id: a.code, name: `${a.district} ${a.name}`, address: '동네 대표점', category: '동네', latitude: a.latitude, longitude: a.longitude })), ...await loadPlaces()]
          if (c.signal.aborted) return null
          hit = rankPlaces(index, q.place, 1)[0]
        }
      }
      const current = currentLocation.current
      const { filter: loc, warning: placeNote } = resolveAiLocation(q, current.filter, current.radiusKm, hit)
      if (loc && loc !== current.filter) {
        setLocation(loc); setRadiusKm(loc.radiusKm); setShowLocation(true)
      }
      setLeaseType(lt)
      if (lt === 'jeonse') setJeonseDeposit(dep); else { setDeposit(dep); setRent(rn) }
      setWeights(w)
      // 구를 말했으면 그 구로 바꾸고, 말하지 않았으면 지금 고른 구를 그대로 둔다.
      const ds = q.districts ?? districts
      if (q.districts) setDistricts(q.districts)
      runWith({ leaseType: lt, deposit: dep, rent: rn, weights: w, locationFilter: loc, districts: ds }, 'hero')
      // 알아들은 조건은 AI 문장이 아니라 실제로 적용한 값으로 보여 준다.
      const heard = [
        ...(q.leaseType ? [q.leaseType === 'jeonse' ? '전세' : '월세'] : []),
        ...(q.deposit != null ? [`${lt === 'jeonse' ? '전세 보증금' : '보증금'} ${manwonLabel(String(q.deposit))}`] : []),
        ...(q.rent != null ? [`월세 ${manwonLabel(String(q.rent))}`] : []),
        ...(q.weights ? [q.situation ? presetLabel(q.situation, lt === 'jeonse') : domains.filter(k => (q.weights![k] ?? 0) >= 50).map(k => `${weightLabels[k]} 중요`).join(', ') || '중요도 조정'] : []),
        ...(q.districts ? [`${districtLabel(q.districts)} 안`] : []),
        ...(loc && !placeNote ? [`기준 위치 ${loc.name} · 반경 ${loc.radiusKm}km`] : []),
      ]
      setNotice([heard.length ? `AI가 알아들은 조건: ${heard.join(' · ')}` : '', placeNote].filter(Boolean).join(' '))
      return placeNote || null
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null
      const msg = e instanceof Error ? e.message : 'AI가 지금 응답하지 않아요.'
      return msg
    }
  }
  /** 조건 넣기의 '말로 찾기': 진행 표시와 오류 표시를 맡고, 이해·적용은 runVoiceText가 한다. */
  async function runVoiceTab(text: string) {
    setVoiceError(''); setVoiceBusy('parse')
    const err = await runVoiceText(text)
    setVoiceBusy('')
    if (err) setVoiceError(err)
  }
  function runVoice(event: React.FormEvent) {
    event.preventDefault()
    void runVoiceTab(voiceText)
  }
  /** 마이크: 누르면 녹음, 다시 누르면(또는 20초 뒤) 멈추고 AI로 글을 만든 다음 바로 조건을 적용한다. */
  async function toggleListening() {
    if (voiceBusy === 'listen') { recorder.current?.stop(); return }
    if (voiceBusy) return
    setVoiceError('')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { setVoiceError('마이크를 쓸 수 없어요. 브라우저 마이크 권한을 켜거나 글로 적어 주세요.'); return }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t))
    const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
    const chunks: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = async () => {
      window.clearTimeout(recordTimer.current)
      stream.getTracks().forEach(t => t.stop())
      recorder.current = null
      const blob = new Blob(chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] })
      if (blob.size < 1200) { setVoiceBusy(''); setVoiceError('녹음된 소리가 너무 짧아요. 마이크 버튼을 누르고 말한 뒤 다시 눌러 주세요.'); return }
      setVoiceBusy('stt')
      try {
        const text = await transcribe(blob)
        setVoiceText(text)
        await runVoiceTab(text)
      } catch (e) {
        setVoiceBusy(''); setVoiceError(e instanceof Error ? e.message : '말을 알아듣지 못했어요. 다시 말하거나 글로 적어 주세요.')
      }
    }
    recorder.current = rec
    rec.start(); setVoiceBusy('listen')
    recordTimer.current = window.setTimeout(() => { if (rec.state === 'recording') rec.stop() }, 20000)
  }

  // 한 번 결과를 본 뒤에는 조건을 바꾸면 바로 다시 계산한다. 금액 입력은 타자 중 깜빡임이 없도록 잠깐 기다린다.
  const budgetKey = useDebounced(JSON.stringify([leaseType, activeDeposit, rent]), 350)
  useEffect(() => {
    if (!autoMode) return
    // 금액 입력이 멈춘(디바운스가 따라잡은) 뒤에만 계산한다.
    if (budgetKey !== JSON.stringify([leaseType, activeDeposit, rent])) return
    const [lt, dep, rn] = JSON.parse(budgetKey) as [LeaseType, string, string]
    const input = { leaseType: lt, deposit: dep, rent: rn, weights, locationFilter, districts }
    const key = keyOf(input)
    if (key === lastKey.current) return
    lastKey.current = key
    const out = compute(input, false)
    if (out.result) { apply(out.result, 'auto'); setFieldErrors({}) }
    else setPendingNote(out.fieldError ? `${out.fieldError.message} 그 전까지는 이전 결과를 보여드려요.` : out.error ?? '')
    // compute·apply는 매 렌더 새로 만들어지지만 입력이 바뀔 때만 다시 계산하면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode, budgetKey, leaseType, activeDeposit, rent, weights, locationFilter, districts, snapshot])

  function reset() {
    setUndo({ leaseType, deposit, jeonseDeposit, rent, weights: { ...weights }, location, radiusKm, districts })
    setLeaseType('monthly'); setJeonseDeposit(''); setDeposit(''); setRent(''); setWeights({ ...DEFAULT_WEIGHTS })
    setResult(null); setAutoMode(false); setPrevRanks(null); setSelected(null); setError(''); setFieldErrors({}); setNotice(''); setPendingNote('')
    setLocation(undefined); setDistricts([]); setRadiusKm(3); setPickingLocation(false); setChecking(false); setCheckPoint(null); setShowCustom(false); setShowLocation(false); lastKey.current = ''
  }
  function restore() {
    if (!undo) return
    setLeaseType(undo.leaseType); setDeposit(undo.deposit); setJeonseDeposit(undo.jeonseDeposit); setRent(undo.rent); setWeights(undo.weights)
    setLocation(undo.location); setRadiusKm(undo.radiusKm); setDistricts(undo.districts ?? []); setShowLocation(!!undo.location); setUndo(null)
  }
  function fillExample(type: LeaseType, dep: string, r = '') {
    setLeaseType(type)
    if (type === 'jeonse') setJeonseDeposit(dep); else { setDeposit(dep); setRent(r) }
    setFieldErrors({}); setError('')
  }
  function startNow() {
    goSearch(); setEditing(true)
    window.setTimeout(() => depositInput.current?.focus(), 60)
  }
  function changeLocation(point?: LocationFilter) { setLocation(point); setPickingLocation(false); setNotice(''); if (point) setShowLocation(true) }
  /** 동네를 고르면 왼쪽 목록 자리에 그 동네 리포트를 연다. 돌아오면 목록의 원래 위치로 간다. */
  function openArea(code: string) {
    if (!selected && !checking) listScroll.current = listPanel.current?.scrollTop ?? 0
    setChecking(false); setCheckPoint(null)
    setSelected(code)
    setRecentCodes(rc => [code, ...rc.filter(c => c !== code)].slice(0, 3))
    if (view !== 'search') goSearch()
    window.setTimeout(() => {
      const title = document.getElementById('report-title')
      if (listPanel.current && getComputedStyle(listPanel.current).overflowY === 'auto') listPanel.current.scrollTo({ top: 0 })
      else title?.scrollIntoView({ block: 'start' })
      title?.focus({ preventScroll: true })
    }, 30)
  }
  function closeArea() {
    const code = selected
    setSelected(null)
    window.setTimeout(() => {
      listPanel.current?.scrollTo({ top: listScroll.current })
      ;(document.getElementById(`card-${code}`)?.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true })
    }, 30)
  }
  function openCheck() {
    if (!selected && !checking) listScroll.current = listPanel.current?.scrollTop ?? 0
    setChecking(true); setPickingLocation(false)
    if (view !== 'search') goSearch()
    window.setTimeout(() => {
      if (listPanel.current && getComputedStyle(listPanel.current).overflowY === 'auto') listPanel.current.scrollTo({ top: 0 })
      // 휴대폰에서는 지도가 목록 아래에 있으니 지도를 화면으로 가져온다
      else document.getElementById('location-map')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 30)
  }
  function closeCheck() {
    setChecking(false); setCheckPoint(null)
    window.setTimeout(() => {
      if (selected) document.getElementById('report-title')?.focus({ preventScroll: true })
      else { listPanel.current?.scrollTo({ top: listScroll.current }); (document.querySelector('.map-check') as HTMLElement | null)?.focus({ preventScroll: true }) }
    }, 30)
  }
  const checkRep = useMemo(() => { if (!checkPoint) return null; const a = areaAt(snapshot.areas, checkPoint.latitude, checkPoint.longitude); return a ? { latitude: a.latitude, longitude: a.longitude, name: a.name } : null }, [checkPoint, snapshot])
  const pickArea = openArea
  const mapSelect = openArea
  function rankChange(r: Recommendation) {
    if (!prevRanks) return null
    const p = prevRanks.get(r.area.code)
    if (p == null) return { cls: 'new', text: '새로 추천' }
    if (p > r.rank) return { cls: 'up', text: `${p - r.rank}계단 올라옴` }
    if (p < r.rank) return { cls: 'down', text: `${r.rank - p}계단 내려감` }
    return null
  }
  function speak() {
    if (!canSpeak || !result) return
    const synth = window.speechSynthesis
    if (speaking) { synth.cancel(); setSpeaking(false); return }
    const text = resultSpeech()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ko-KR'; u.rate = 0.95
    u.onend = () => setSpeaking(false); u.onerror = () => setSpeaking(false)
    rememberSpoken(text)
    synth.cancel(); synth.speak(u); setSpeaking(true)
  }
  /** 결과를 말로: AI 비교 설명이 있으면 그것을, 없으면 추천 이유를 읽는다. */
  function resultSpeech() {
    if (!result) return '아직 추천 결과가 없어요. 먼저 조건을 말해 주세요.'
    const kind = resultJeonse ? '전세' : '월세'
    const ai = explain?.key === explainKey && explain.status === 'done' ? explain.data : undefined
    return !result.recommendations.length
      ? '조건에 맞는 동네를 찾지 못했어요. 예산을 조금 높여 다시 찾아보세요.'
      : ai
        ? [`${kind} 추천 동네 ${result.recommendations.length}곳을 비교해 드릴게요.`, ai.summary, ...ai.areas.map(a => `${a.rank}위 ${result.recommendations.find(r => r.rank === a.rank)?.area.name ?? ''}. ${a.headline}. 좋은 점, ${a.pros.join(' ')} 아쉬운 점, ${a.cons.join(' ')}`), ai.tip].join(' ')
        : [`${kind} 추천 동네 ${result.recommendations.length}곳을 알려드릴게요.`, ...result.recommendations.map(r => `${r.rank}위, ${r.area.district} ${r.area.name}. ${reasonFor(r)}`)].join(' ')
  }

  // ── AI 비서: 들은 말을 화면 명령이나 조건으로 처리한다. 화면이 바뀌면 화면 안내가 읽어 주므로 따로 말하지 않는다.
  const ASSISTANT_HELP = '이렇게 말할 수 있어요. 조건은, 송파구에서 보증금 천만 원에 월세 육십, 또는 전세 3억에 회사는 강남역. 결과에서는, 1위 자세히, 비교 설명 읽어 줘, 돌아가기. 그 밖에, 다시 말해 줘, 처음부터, 그리고 안내 꺼 줘.'
  async function assistantHandle(raw: string): Promise<AssistantReply> {
    const n = raw.replace(/[\s.,!?~]/g, '')
    if (!n) return { say: '잘 듣지 못했어요. 다시 말해 주세요.' }
    if (/^(비서|AI비서)?(꺼|끄|그만|종료|끝내)/.test(n) || /(비서|안내)(를|좀)?(꺼|끄|그만|종료)/.test(n)) return { off: true }
    if (/도움말|뭐라고말|어떻게말|할수있는/.test(n)) return { say: ASSISTANT_HELP }
    if (/^(다시|한번더)(말|읽|들려)|다시말해|다시읽어/.test(n)) return { say: lastSpokenText() || '아직 읽어 드린 내용이 없어요.' }
    if (/처음부터|초기화|새로찾/.test(n)) { reset(); goHome(); return { say: '조건을 모두 지웠어요. 새 조건을 말해 주세요.' } }
    const rankMatch = n.match(/([123일이삼첫두세])(번째|위|번)/)
    if (rankMatch && n.length <= 16) {
      if (!result?.recommendations.length) return { say: '아직 추천 결과가 없어요. 먼저 조건을 말해 주세요.' }
      const rank = ({ 일: 1, 첫: 1, 이: 2, 두: 2, 삼: 3, 세: 3 } as Record<string, number>)[rankMatch[1]] ?? Number(rankMatch[1])
      const r = result.recommendations.find(x => x.rank === rank)
      if (!r) return { say: `${rank}위는 없어요. 추천은 ${result.recommendations.length}곳이에요.` }
      openArea(r.area.code)
      return {}
    }
    if (/^(돌아가|뒤로|이전|목록)/.test(n)) {
      if (checking) { closeCheck(); return {} }
      if (selected) { closeArea(); return {} }
      if (view === 'search') { goHome(); return {} }
      return { say: '지금이 첫 화면이에요.' }
    }
    if (/(비교|설명|결과|추천).*(읽|들려|알려)/.test(n) && result) return { say: resultSpeech() }
    const err = await runVoiceText(raw)
    return err ? { say: err } : {}
  }
  async function share() {
    if (!result) return
    const budgetText = resultJeonse ? `전세 보증금 ${krwLabel(result.budget.maxDepositKrw)} 이하` : `보증금 ${krwLabel(result.budget.maxDepositKrw)} · 월세 ${krwLabel(result.budget.maxMonthlyRentKrw)} 이하`
    const text = [`서울사이 추천 동네 (${budgetText})`, ...result.recommendations.map(r => `${r.rank}위 ${r.area.district} ${r.area.name} — ${reasonFor(r)}`)].join('\n')
    const url = window.location.href
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ title: '서울사이 추천 동네', text, url }); return }
      await navigator.clipboard.writeText(`${text}\n같은 조건으로 보기: ${url}`)
      setNotice('추천 결과와 링크를 복사했어요. 링크를 열면 같은 조건의 결과가 바로 보여요.')
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setNotice('공유하지 못했어요. 화면을 캡처해서 공유해 주세요.')
    }
  }
  async function changeData(mode: string) {
    const resetResult = () => { setResult(null); setAutoMode(false); setSelected(null); lastKey.current = '' }
    if (mode === 'local') {
      setLoading(true); setNotice('')
      try {
        const next: unknown = await loadLocalSnapshot(AbortSignal.timeout(30000), true); validateSnapshot(next)
        setSnapshot(next); setLoadedLocal(true); setLoadedRemote(false); setDataState('ready'); resetResult()
      } catch { setNotice('서울 실제 데이터를 읽지 못했어요. 기존 데이터를 유지합니다.') }
      finally { setLoading(false) }
      return
    }
    if (mode === 'demo') {
      requestController.current?.abort(); remoteRequested.current = false
      setSnapshot(demoSnapshot); resetResult(); setError(''); setNotice('체험 데이터로 바꿨어요.'); setLoading(false); setLoadedRemote(false); setLoadedLocal(false); setDataState('demo')
      return
    }
    if (!supabaseConfigured) { setNotice('아직 Supabase 프로젝트가 연결되지 않았습니다.'); return }
    requestController.current?.abort()
    const controller = new AbortController(); requestController.current = controller; remoteRequested.current = true
    setLoading(true); setError(''); setNotice('')
    const timeout = setTimeout(() => controller.abort(), 12000)
    try {
      const next = await loadSnapshot(controller.signal)
      if (!remoteRequested.current || controller.signal.aborted) return
      setSnapshot(next); resetResult(); setLoadedRemote(true); setLoadedLocal(false); setDataState(next.isDemo ? 'demo' : 'ready')
      setNotice(next.isDemo ? 'Supabase에 저장된 체험 스냅샷입니다.' : 'Supabase의 최신 스냅샷을 불러왔습니다.')
    } catch (e) {
      if (remoteRequested.current) setNotice(`${e instanceof Error ? e.message : '연결 시간이 초과됐습니다.'} 마지막으로 불러온 데이터를 유지합니다.`)
    } finally { clearTimeout(timeout); if (requestController.current === controller) setLoading(false) }
  }
  function openGuide() { setShowData(true) }
  // 데이터 안내 창: Esc로 닫고, 열리면 닫기 버튼에 초점을 둔다.
  useEffect(() => {
    if (!showData) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowData(false) }
    window.addEventListener('keydown', onKey)
    window.setTimeout(() => document.getElementById('guide-close')?.focus(), 0)
    return () => window.removeEventListener('keydown', onKey)
  }, [showData])

  // 공유 링크(?t=m&d=1000&r=65&w=balanced)로 들어오면 같은 조건의 결과를 바로 보여준다.
  useEffect(() => {
    if (dataState !== 'ready' || urlApplied.current) return
    urlApplied.current = true
    const q = new URLSearchParams(window.location.search)
    const d = q.get('d')
    if (!d || !/^\d+$/.test(d)) return
    const lt: LeaseType = q.get('t') === 'j' ? 'jeonse' : 'monthly'
    const r = q.get('r') ?? ''
    const ws = q.get('w') ?? ''
    const p = presets.find(x => x.id === ws)
    const nums = /^\d+(,\d+){3,4}$/.test(ws) ? ws.split(',').map(Number) : null
    const w: Weights = p ? { ...p.weights } : nums ? Object.fromEntries(domains.map((k, i) => [k, nums[i] ?? 0])) as Weights : { ...DEFAULT_WEIGHTS }
    const lat = Number(q.get('lat')), lng = Number(q.get('lng')), km = Number(q.get('km') ?? 3) || 3
    const place = q.get('place')
    const ds = (q.get('g') ?? '').split(',').map(toDistrict).filter((x): x is string => !!x)
    const loc: LocationFilter | undefined = place && Number.isFinite(lat) && Number.isFinite(lng) && lat && lng ? { name: place, latitude: lat, longitude: lng, radiusKm: km } : undefined
    setLeaseType(lt)
    if (lt === 'jeonse') setJeonseDeposit(d); else { setDeposit(d); setRent(r) }
    setWeights(w)
    if (loc) { setLocation(loc); setRadiusKm(km); setShowLocation(true) }
    if (ds.length) setDistricts(ds)
    const input = { leaseType: lt, deposit: d, rent: r, weights: w, locationFilter: loc, districts: ds }
    const out = compute(input, false)
    if (!out.result) return
    lastKey.current = keyOf(input)
    apply(out.result, 'manual')
    setEditing(false); setView('search')
    // 처음 데이터가 준비됐을 때 한 번만 실행한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataState])

  // 결과가 바뀌면 주소에 조건을 담아 둔다. 새로고침하거나 링크를 보내도 같은 결과가 나온다.
  useEffect(() => {
    if (!urlApplied.current || view !== 'search') return
    if (!result) { window.history.replaceState({ v: 'search' }, '', '?view=search'); return }
    const q = new URLSearchParams()
    q.set('t', jeonse ? 'j' : 'm'); q.set('d', cleanNumber(activeDeposit))
    if (!jeonse) q.set('r', cleanNumber(rent))
    q.set('w', preset !== 'custom' ? preset : domains.map(k => weights[k]).join(','))
    if (districts.length) q.set('g', districts.join(','))
    if (locationFilter) { q.set('place', locationFilter.name); q.set('lat', locationFilter.latitude.toFixed(5)); q.set('lng', locationFilter.longitude.toFixed(5)); q.set('km', String(radiusKm)) }
    window.history.replaceState({ v: 'search' }, '', `?${q}`)
    // 결과가 바뀔 때만 주소를 고친다(입력 중간 값은 담지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, view])

  // 결과가 없거나 적을 때 "이렇게 바꾸면 나와요"를 계산해 한 번에 바꿀 수 있게 한다. 입력은 사용자가 누를 때만 바꾼다.
  const suggestions = useMemo(() => {
    if (!result || result.recommendations.length >= 3) return null
    const b = result.budget
    const lf = result.locationFilter
    const run = (budget: Budget, filter?: LocationFilter) => { try { return recommend(scopedSnapshot, budget, weights, filter).recommendations.length } catch { return 0 } }
    let radius: { km: number; count: number } | null = null
    if (lf) for (const km of [5, 10, 20].filter(k => k > lf.radiusKm)) {
      const n = run(b, { ...lf, radiusKm: km })
      if (n > result.recommendations.length) { radius = { km, count: n }; break }
    }
    let budget: { deposit: number; rent: number; label: string } | null = null
    if (!result.recommendations.length) {
      const d0 = Math.round(b.maxDepositKrw / 10000), r0 = Math.round(b.maxMonthlyRentKrw / 10000)
      const tries: [number, number][] = []
      // 사람이 말하기 쉬운 금액(보증금 500만 원 단위, 월세 5만 원 단위, 전세 1,000만 원 단위)으로 올려 본다.
      const up = (v: number, unit: number) => Math.ceil(v / unit) * unit
      for (let i = 1; i <= 10; i++) {
        if (b.leaseType === 'jeonse') tries.push([up(d0 + 2000 * i, 1000), 0])
        else tries.push([d0, up(r0 + 5 * i, 5)], [up(d0 + 500 * i, 500), up(r0 + 5 * i, 5)])
      }
      for (const [d, r] of tries) {
        try { if (run(parseBudget(String(d), String(r), b.leaseType ?? 'monthly'), lf) > 0) { budget = { deposit: d, rent: r, label: b.leaseType === 'jeonse' ? `전세 보증금 ${manwonLabel(String(d))}` : `보증금 ${manwonLabel(String(d))} · 월세 ${manwonLabel(String(r))}` }; break } } catch { /* 범위를 벗어난 금액 */ }
      }
    }
    return radius || budget ? { radius, budget } : null
  }, [result, scopedSnapshot, weights])
  function applyBudget(d: number, r: number) {
    if (jeonse) setJeonseDeposit(String(d)); else { setDeposit(String(d)); setRent(String(r)) }
  }

  // 첫 화면 미리보기: 실제 데이터로 '보증금 1,000만 · 월세 65만 원, 골고루' 조건을 계산한 결과
  const preview = useMemo(() => {
    if (dataState !== 'ready') return null
    try { return recommend(snapshot, parseBudget('1000', '65', 'monthly'), DEFAULT_WEIGHTS).recommendations.slice(0, 3) } catch { return null }
  }, [snapshot, dataState])

  const areaCountLabel = dataState === 'loading' ? '400여' : snapshot.areas.length.toLocaleString('ko-KR')
  const depositLabel = manwonLabel(activeDeposit), rentLabel = manwonLabel(rent)
  const totalLabel = stats.total ? `${Math.round(stats.total / 10000).toLocaleString('ko-KR')}만 건` : ''
  const top1 = preview?.[0]
  const filtersOpen = showCustom || showLocation
  const filterCount = (preset === 'custom' ? 1 : 0) + (location ? 1 : 0) + (districts.length ? 1 : 0)
  const heroLine = dataState === 'loading' ? '서울 동네 데이터를 불러오는 중이에요. 처음 한 번만 잠시 기다려 주세요.' : snapshot.isDemo ? '체험 모드예요. 지금 보이는 점수와 거래는 가상 값이에요.' : `서울 1인 가구를 위한 동네 추천. 실거래 ${totalLabel}으로 서울 ${areaCountLabel}개 동을 비교해, 예산 안에서 나에게 맞는 세 곳과 그 이유를 알려드려요.`
  const leaseButtons = (prefix: string) => (['monthly', 'jeonse'] as const).map(type => <button key={`${prefix}-${type}`} type="button" aria-pressed={leaseType === type} className={leaseType === type ? 'selected' : ''} onClick={() => { setLeaseType(type); setFieldErrors({}); setError('') }}>{type === 'monthly' ? '월세' : '전세'}</button>)
  const excludedCodes = useMemo(() => result ? new Set(result.excluded.map(e => e.area.code)) : undefined, [result])
  const presetName = preset === 'custom' ? '직접 조절한 중요도' : presetLabel(preset, jeonse)
  const condChips = [jeonse ? '전세' : '월세', activeDeposit ? `${jeonse ? '보증금' : '보증금'} ${depositLabel}` : '보증금 미입력', ...(!jeonse ? [rent ? `월세 ${rentLabel}` : '월세 미입력'] : []), presetName, ...(districts.length ? [`${districtLabel(districts)} 안`] : []), ...(locationFilter ? [`${locationFilter.name} ${radiusKm}km`] : [])]

  // ── AI 비교 설명: 결과가 멈추고 1초 뒤 한 번만 요청한다. 같은 조건이면 다시 요청하지 않는다.
  const explainKey = result && result.recommendations.length ? JSON.stringify([snapshot.id, result.order, result.recommendations.map(r => [r.area.code, r.totalScore, r.matchRatio]), result.budget, result.effectiveWeights, result.locationFilter ?? null, districts]) : ''
  useEffect(() => {
    if (!explainKey || !result) return
    if (explain?.key === explainKey) return
    const c = new AbortController()
    const res = result, priority = presetName, ds = districts
    const t = window.setTimeout(() => {
      setExplain({ key: explainKey, status: 'loading' })
      explainTop3(explainBody(res, priority, ds), c.signal)
        .then(data => { if (!c.signal.aborted) setExplain({ key: explainKey, status: 'done', data }) })
        .catch(e => { if (!c.signal.aborted) setExplain({ key: explainKey, status: 'error', error: e instanceof Error ? e.message : 'AI가 지금 응답하지 않아요.' }) })
    }, 1000)
    return () => { window.clearTimeout(t); c.abort() }
    // 결과(조건)가 바뀔 때만 다시 요청한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explainKey])
  const aiExplain = explain?.key === explainKey ? explain : null

  // ── 결과 안정성: 비중을 5점씩 옮겨 다시 계산해도 TOP 3가 그대로인지(결과가 나온 뒤 조금씩 나눠 계산)
  const [stability, setStability] = useState<{ key: string; data: Stability } | null>(null)
  useEffect(() => {
    if (!result || result.order === 'budget-fit' || result.recommendations.length < 2) return
    const c = new AbortController(), key = explainKey
    const t = window.setTimeout(() => { measureStability(scopedSnapshot, result, c.signal).then(data => { if (data && !c.signal.aborted) setStability({ key, data }) }).catch(() => {}) }, 400)
    return () => { window.clearTimeout(t); c.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explainKey, scopedSnapshot])
  const stable = stability && stability.key === explainKey ? stability.data : null
  const stableLine = (() => {
    if (!result || !stable) return null
    const n = result.recommendations.length, kept = result.recommendations.filter(r => !stable.drops[r.area.code]).length
    return kept === n ? `비중을 ${SHIFT}점씩 바꿔 ${stable.total}가지로 다시 계산해도 ${n}곳 모두 그대로예요.`
      : `비중을 ${SHIFT}점씩 바꿔 ${stable.total}가지로 다시 계산하면 ${n}곳 중 ${kept}곳은 늘 그대로이고, ${n - kept}곳은 바뀔 수 있어요.`
  })()

  // ── 화면 안내(켜 두면 화면이 바뀔 때마다 AI가 지금 화면을 말로 정리해 읽어 준다)
  const guideInfo = useMemo(() => {
    if (dataState === 'loading') return null
    const cond = `${condChips[0]} 거래, ${condChips.slice(1).join(', ')}`
    if (view === 'home') {
      if (startMode === 'voice') return { screen: '첫 화면 말로 찾기', facts: ['원하는 조건을 말하거나 적으면 AI가 예산과 중요한 것을 알아듣고 바로 찾아 줘요.', '예를 들어 송파구에서 천만 원에 월세 육십, 밤늦게 퇴근해요 처럼 말하면 돼요.'], actions: ['마이크로 말하기', '이 조건으로 찾기', '직접 입력 탭'] }
      return { screen: '첫 화면', facts: ['서울 1인 가구에게 예산에 맞는 동네 세 곳을 골라 주는 서비스예요.', `서울 ${areaCountLabel}개 동네를 실제 전월세 계약 기록으로 비교해요.`, '조건 넣기 카드에 보증금과 월세를 적고, 필요하면 지역 정하기에서 구를 고를 수 있어요.', ...(top1 ? [`예시로 보증금 1,000만 원, 월세 65만 원이면 1위는 ${top1.area.district} ${top1.area.name}이에요.`] : [])], actions: ['보증금 입력칸', '월세 입력칸', '동네 찾기', '큰 글씨'] }
    }
    if (checking) {
      return { screen: '위치 찍어 보기', facts: ['동네 점수는 동마다 대표점 한 곳에서 계산해요. 이 화면에서는 고른 자리에서 다시 계산해 대표점과 비교해요.', checkPoint ? `${checkPoint.name}을 골랐어요. ${checkRep ? `${checkRep.name} 안이에요.` : '비교할 수 있는 동네 경계 밖이에요.'} 비교 표는 아래에 있어요.` : '아직 고른 위치가 없어요. 지도를 누르거나 이름으로 찾아 정할 수 있어요.', '추천 순위는 바뀌지 않아요.'], actions: ['이름으로 위치 정하기 입력칸', '위치 찍기 끝내기'] }
    }
    if (selectedArea) {
      const r = selectedRec
      const min = walkMinutes(selectedArea)
      return { screen: '동네 리포트', facts: [
        `${selectedArea.district} ${selectedArea.name} 리포트예요. ${fromCityHall(selectedArea.latitude, selectedArea.longitude)}에 있어요.`,
        r ? `추천 ${r.rank}위, 종합 ${Math.round(r.totalScore)}점이에요. 항목별로 ${domains.map(k => `${weightLabels[k]} ${Math.round(r.componentScores[k] ?? 0)}점`).join(', ')}이에요.` : (explorerNote || '추천 목록에 없는 동네예요.'),
        ...(r ? ['안전시설 점수는 안심귀갓길 시설이 가까이 많은지만 본 값이라 실제 안전한 정도와는 달라요.'] : []),
        ...(min != null ? [`지하철역까지 걸어서 약 ${min}분이에요.`] : []),
        ...lifeFacts(selectedArea).slice(0, 4).map(f => f.text),
        ...(r ? [`지난 계약 ${r.sampleCount}건 가운데 내 예산에 맞는 계약은 ${r.budgetMatchCount}건이에요.`] : []),
      ], actions: ['추천 목록으로', '계산 방법과 출처'] }
    }
    if (result && result.recommendations.length) {
      return { screen: '결과 화면', facts: [
        `지금 조건: ${cond}.`,
        `추천 ${result.recommendations.length}곳, 예산 안 후보 ${result.candidateCount}곳이에요.`,
        ...result.recommendations.map(r => { const min = walkMinutes(r.area); return `${r.rank}위 ${r.area.district} ${r.area.name}, ${Math.round(r.totalScore)}점, ${fromCityHall(r.area.latitude, r.area.longitude)}${min != null ? `, 역까지 걸어서 ${min}분` : ''}.` }),
      ], actions: ['추천 카드', '읽어주기', '조건 바꾸기', '처음부터'] }
    }
    if (result) {
      return { screen: '결과 없음', facts: [`지금 조건: ${cond}.`, '예산에 맞는 계약이 10건 이상인 동네가 없어서 추천하지 못했어요.', ...(suggestions?.budget ? [`${suggestions.budget.label}으로 바꾸면 추천이 나와요.`] : [])], actions: [...(suggestions?.budget ? [`${suggestions.budget.label}으로 찾기`] : []), '조건 바꾸기'] }
    }
    const errs = Object.values(fieldErrors).filter(Boolean) as string[]
    return { screen: '조건 입력 화면', facts: ['왼쪽에 내 조건 입력 칸, 오른쪽에 서울 지도가 있어요.', ...(errs.length ? errs : ['최대 보증금과 최대 월세를 만원 단위로 적고 동네 찾기를 누르면 돼요.'])], actions: ['최대 보증금 입력칸', '최대 월세 입력칸', '동네 찾기'] }
    // 화면을 이루는 값이 바뀔 때만 다시 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataState, view, startMode, selected, result, fieldErrors, top1, checking, checkPoint, checkRep, districts])
  const guideKey = guideInfo ? JSON.stringify(guideInfo) : ''
  useEffect(() => {
    if (!guide || !guideKey || !guideInfo || !canSpeak) return
    const c = new AbortController()
    setGuideWaiting(true)
    const t = window.setTimeout(() => {
      guideScreen(guideInfo, c.signal)
        .then(text => { if (!c.signal.aborted) sayGuide(text) })
        .catch(e => { if (!c.signal.aborted) sayGuide(e instanceof Error ? e.message : '화면 안내를 불러오지 못했어요.') })
        .finally(() => { if (!c.signal.aborted) setGuideWaiting(false) })
    }, 900)
    return () => { window.clearTimeout(t); c.abort(); setGuideWaiting(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide, guideKey])
  function sayGuide(text: string) {
    const synth = window.speechSynthesis
    // AI 비서가 말하는 중이면 끊지 않고 이어서 읽는다.
    if (!assistantOn.current) { synth.cancel(); setSpeaking(false) }
    rememberSpoken(text)
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ko-KR'; u.rate = 0.95
    synth.speak(u)
  }

  const examples = <div className="example-chips"><span>예시로 채우기</span>
    <button type="button" className="chip" onClick={() => fillExample('monthly', '1000', '65')}>사회초년생 1,000 / 65</button>
    <button type="button" className="chip" onClick={() => fillExample('monthly', '500', '50')}>대학생 500 / 50</button>
    <button type="button" className="chip" onClick={() => fillExample('jeonse', '30000')}>전세 3억</button>
  </div>

  return <div className={`app view-${view}`}>
    <a className="skip-link" href="#main">본문으로 바로가기</a>
    {canSpeak && <button type="button" className="skip-link" onClick={() => document.getElementById('assistant-button')?.click()}>시각장애인 안내 켜기</button>}
    <header className="site-header">
      <button type="button" className="brand" onClick={goHome} aria-label="서울사이 첫 화면으로"><span className="brand-mark" aria-hidden="true" />서울사이</button>
      <nav className="nav-pill" aria-label="주 메뉴">
        <button type="button" className={view === 'search' ? 'active' : ''} aria-current={view === 'search' ? 'page' : undefined} onClick={goSearch}>동네 찾기</button>
        <button type="button" onClick={openGuide}>데이터 안내</button>
        <a href={SEOUL_HOUSING_HELP} target="_blank" rel="noreferrer">안심계약 도움<ArrowUpRight size={13} aria-hidden="true" /></a>
      </nav>
      <div className="view-settings" role="group" aria-label="화면 설정">
        <button type="button" className="toggle" aria-pressed={comfort} onClick={() => setComfort(!comfort)}><span className="aa" aria-hidden="true">가<b>가</b></span>큰 글씨</button>
        <button type="button" className="toggle" aria-pressed={contrast} onClick={() => setContrast(!contrast)}><Contrast size={15} aria-hidden="true" />고대비</button>
        {canSpeak && <Assistant canRecord={canRecord} handle={assistantHandle}
          onOn={() => { assistantOn.current = true; setGuide(true) }}
          onOff={() => { assistantOn.current = false; setGuide(false) }} />}
      </div>
    </header>

    {view === 'home' ? <main className="home" id="main">
      <div className={`home-map ${flatMap ? '' : 'is-3d'} ${narrow ? 'is-shot' : ''}`}>{narrow
        // 휴대폰: 3D 모형을 그리지 않고 미리 찍어 둔 3D 화면 이미지(예시 TOP 3 포함)를 보여 준다.
        ? <img className="hero-shot" src="/images/seoul-3d-mobile.webp" width={1200} height={862} alt="" aria-hidden="true" decoding="async" />
        : flatMap
        ? <div className="hero-map-wrap" aria-hidden="true"><HeroMap areas={dataState === 'ready' ? snapshot.areas : noAreas} picks={preview} /></div>
        : <Suspense fallback={null}><HeroScene picks={preview} onFail={() => setSceneFailed(true)} /></Suspense>}</div>

      <section className="home-copy" aria-labelledby="hero-title">
        <h1 id="hero-title"><span className="h1-strong">예산부터 정하세요.</span><span className="h1-light">동네는 저희가 찾을게요.</span></h1>
        <p className="hero-lede" role="status">{heroLine}</p>
      </section>

      {top1 && <article className="hero-feature" aria-label="예시 결과">
        <div className="feature-row">
          <span className="rank-mark top" aria-hidden="true">1</span>
          <div>
            <p className="feature-name"><span className="sr-only">1위 </span>{top1.area.name}</p>
            <p className="meta">{top1.area.district}{walkMinutes(top1.area) != null ? ` · 역까지 걸어서 ${walkMinutes(top1.area)}분` : ''}</p>
          </div>
          <ScoreBadge score={top1.totalScore} />
        </div>
        <p className="feature-reason">{reasonFor(top1)}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { fillExample('monthly', '1000', '65'); setWeights({ ...DEFAULT_WEIGHTS }); runWith({ leaseType: 'monthly', deposit: '1000', rent: '65', weights: { ...DEFAULT_WEIGHTS }, locationFilter }, 'hero') }}>이 조건으로 보기</button>
        <span className="feature-context">보증금 1,000만 · 월세 65만</span>
      </article>}

      <section className="start-card" aria-labelledby="start-title">
        <div className="start-head">
          <h2 id="start-title">조건 넣기</h2>
          <div className="seg" role="tablist" aria-label="입력 방식">
            <button type="button" role="tab" id="tab-type" aria-controls="panel-type" aria-selected={startMode === 'type'} className={startMode === 'type' ? 'selected' : ''} onClick={() => setStartMode('type')}><Keyboard size={15} aria-hidden="true" />직접 입력</button>
            <button type="button" role="tab" id="tab-voice" aria-controls="panel-voice" aria-selected={startMode === 'voice'} className={startMode === 'voice' ? 'selected' : ''} onClick={() => setStartMode('voice')}><Mic size={15} aria-hidden="true" />말로 찾기</button>
          </div>
        </div>
        {startMode === 'type' ? <form id="panel-type" role="tabpanel" aria-labelledby="tab-type" className="start-form" onSubmit={e => runRecommendation(e, 'hero')} noValidate>
          <div className="start-fields">
            <div className="seg seg-block" role="group" aria-label="거래 유형">{leaseButtons('hero')}</div>
            <label className={`field ${fieldErrors.deposit ? 'invalid' : ''}`}><span>{jeonse ? '전세 보증금' : '보증금'}</span><span className="field-input"><input inputMode="numeric" autoComplete="off" placeholder={jeonse ? '예: 30000' : '예: 1000'} value={activeDeposit} onChange={e => { setActiveDeposit(e.target.value); if (fieldErrors.deposit) setFieldErrors(f => ({ ...f, deposit: undefined })) }} /><em>만원</em></span></label>
            {!jeonse && <label className={`field ${fieldErrors.rent ? 'invalid' : ''}`}><span>월세</span><span className="field-input"><input inputMode="numeric" autoComplete="off" placeholder="예: 65" value={rent} onChange={e => { setRent(e.target.value); if (fieldErrors.rent) setFieldErrors(f => ({ ...f, rent: undefined })) }} /><em>만원</em></span></label>}
            <label className="field field-wide"><span>무엇이 중요한가요</span><span className="field-input"><select value={preset} onChange={e => { const p = presets.find(x => x.id === e.target.value); if (p) setWeights({ ...p.weights }) }}>
              {presets.map(p => <option key={p.id} value={p.id}>{presetLabel(p.id, jeonse, p.name)}</option>)}
              {preset === 'custom' && <option value="custom">직접 조절한 중요도</option>}
            </select><ChevronDown size={15} aria-hidden="true" /></span></label>
          </div>
          <details className="start-region" open={districts.length > 0 || !!location}>
            <summary><MapPin size={15} aria-hidden="true" />지역 정하기 <small>{districts.length || location ? [districts.length ? `${districtLabel(districts)} 안` : '', location ? `${location.name} ${radiusKm}km` : ''].filter(Boolean).join(' · ') : '선택 · 고르지 않으면 서울 전체'}</small><ChevronDown size={15} aria-hidden="true" /></summary>
            <div className="start-region-body">
              <h3 className="start-region-title">구 고르기</h3>
              <DistrictPicker value={districts} onChange={setDistricts} idPrefix="hero-district" />
              <h3 className="start-region-title">학교·직장 근처로 좁히기</h3>
              <LocationPicker areas={snapshot.areas} value={locationFilter} radiusKm={radiusKm} picking={false} onRadius={setRadiusKm} onChange={changeLocation} onPick={() => { goSearch(); setShowLocation(true); setPickingLocation(true) }} />
            </div>
          </details>
          {examples}
          <div className="start-actions">
            <button type="submit" className="btn btn-primary" disabled={dataState === 'loading' || loading}>{dataState === 'loading' ? '데이터 불러오는 중' : '동네 찾기'}</button>
            <button type="button" className="btn btn-ghost" onClick={startNow}>지도 먼저 보기</button>
          </div>
        </form> : <form id="panel-voice" role="tabpanel" aria-labelledby="tab-voice" className="start-form" onSubmit={runVoice} noValidate>
          <label htmlFor="voice-text" className="voice-label">원하는 조건을 말하거나 적어 주세요</label>
          <div className="voice-row">
            <textarea id="voice-text" rows={2} placeholder="예: 송파구에서 천만 원에 월세 육십, 밤늦게 퇴근해요" value={voiceText} onChange={e => { setVoiceText(e.target.value); setVoiceError('') }} aria-describedby="voice-help voice-privacy" disabled={voiceBusy === 'listen' || voiceBusy === 'stt'} />
            {canRecord && <button type="button" className={`btn btn-icon mic ${voiceBusy === 'listen' ? 'on' : ''}`} aria-pressed={voiceBusy === 'listen'} disabled={voiceBusy === 'stt' || voiceBusy === 'parse'} onClick={() => void toggleListening()} aria-label={voiceBusy === 'listen' ? '말하기 끝내기' : '마이크로 말하기'}><Mic size={18} aria-hidden="true" /></button>}
          </div>
          <p id="voice-help" className="voice-help" role="status">{voiceBusy === 'listen' ? '듣고 있어요. 다 말했으면 마이크 버튼을 다시 눌러 주세요. (최대 20초)'
            : voiceBusy === 'stt' ? <><LoaderCircle className="spin" size={13} aria-hidden="true" />목소리를 글로 바꾸는 중이에요…</>
            : voiceBusy === 'parse' ? <><LoaderCircle className="spin" size={13} aria-hidden="true" />AI가 조건을 이해하는 중이에요…</>
            : '금액(보증금·월세·전세), 생활 상황, 다니는 학교·회사를 편하게 말하거나 적어 주세요. AI가 알아듣고 바로 찾아 드려요.'}</p>
          {voiceError && <p className="field-error" role="alert">{voiceError}</p>}
          <p id="voice-privacy" className="voice-privacy">말한 소리와 문장은 AI(Groq)로 보내 글로 바꾸고 조건을 이해하는 데만 써요. 서울사이는 저장하지 않아요.</p>
          <div className="start-actions">
            <button type="submit" className="btn btn-primary" disabled={dataState === 'loading' || loading || !voiceText.trim() || !!voiceBusy}>{voiceBusy === 'parse' ? '이해하는 중…' : '이 조건으로 찾기'}</button>
          </div>
        </form>}
      </section>
    </main>

    : <main className="search" id="main">
      <aside className="list-panel" ref={listPanel} aria-label="조건과 추천 목록">
        {checking ? <PointCheck snapshotId={snapshot.id} areas={snapshot.areas} point={checkPoint} backLabel={selectedArea ? `${selectedArea.name} 리포트로` : result ? '추천 목록으로' : '목록으로'} onPoint={setCheckPoint} onClear={() => setCheckPoint(null)} onBack={closeCheck} onOpenArea={openArea} />
        : selectedArea ? <AreaReport area={selectedArea} rec={selectedRec} result={result} snapshot={snapshot} leaseType={leaseType} note={explorerNote} onBack={closeArea} onCheck={openCheck} />
        : <>
          <div className="panel-head">
            <h1>지도에서 동네 찾기</h1>
            <p className="panel-count">{result
              ? result.recommendations.length ? <><b>{result.recommendations.length}곳</b> 추천 · 예산 안 후보 {result.candidateCount.toLocaleString('ko-KR')}곳</> : <>조건에 맞는 동네가 없어요</>
              : <>서울 {areaCountLabel}개 동네를 비교해요</>}</p>
          </div>

          <section className="cond-card" aria-labelledby="cond-title">
            <div className="cond-head">
              <h2 id="cond-title">내 조건</h2>
              <div className="cond-tools">
                {result && <button type="button" className="btn btn-ghost btn-sm" aria-expanded={editing} aria-controls="cond-form" onClick={() => setEditing(!editing)}>{editing ? '접기' : '조건 바꾸기'}</button>}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { reset(); setEditing(true) }}><RotateCcw size={14} aria-hidden="true" />처음부터</button>
              </div>
            </div>
            {undo && <div className="undo-bar" role="status"><span>조건을 모두 지웠어요.</span><button type="button" className="btn btn-secondary btn-sm" onClick={restore}><Undo2 size={14} aria-hidden="true" />되돌리기</button></div>}
            {!editing && <ul className="cond-chips" aria-label="지금 조건">{condChips.map(c => <li key={c}>{c}</li>)}</ul>}

            {editing && <form id="cond-form" className="cond-form" onSubmit={runRecommendation} noValidate>
              <div className="form-row">
                <div className="seg" role="group" aria-label="거래 유형">{leaseButtons('panel')}</div>
                <TermHelp />
              </div>
              <div className="money-grid">
                <div>
                  <label htmlFor="deposit">{jeonse ? '최대 전세 보증금' : '최대 보증금'}</label>
                  <div className={`money-input ${fieldErrors.deposit ? 'invalid' : ''}`}><input ref={depositInput} id="deposit" inputMode="numeric" autoComplete="off" placeholder={jeonse ? '예: 30000' : '예: 1000'} value={activeDeposit} onChange={e => { setActiveDeposit(e.target.value); if (fieldErrors.deposit) setFieldErrors(f => ({ ...f, deposit: undefined })) }} aria-invalid={!!fieldErrors.deposit} aria-describedby={fieldErrors.deposit ? 'deposit-error deposit-amount' : 'deposit-amount'} /><span>만원</span></div>
                  <p className="amount-preview" id="deposit-amount">{depositLabel ? `= ${depositLabel}` : ''}</p>
                </div>
                {!jeonse && <div>
                  <label htmlFor="rent">최대 월세</label>
                  <div className={`money-input ${fieldErrors.rent ? 'invalid' : ''}`}><input ref={rentInput} id="rent" inputMode="numeric" autoComplete="off" placeholder="예: 65" value={rent} onChange={e => { setRent(e.target.value); if (fieldErrors.rent) setFieldErrors(f => ({ ...f, rent: undefined })) }} aria-invalid={!!fieldErrors.rent} aria-describedby={fieldErrors.rent ? 'rent-error rent-amount' : 'rent-amount'} /><span>만원</span></div>
                  <p className="amount-preview" id="rent-amount">{rentLabel ? `= 한 달 ${rentLabel}` : ''}</p>
                </div>}
              </div>
              {fieldErrors.deposit && <p className="field-error" id="deposit-error" role="alert">{fieldErrors.deposit}</p>}
              {fieldErrors.rent && <p className="field-error" id="rent-error" role="alert">{fieldErrors.rent}</p>}
              {!jeonse && stats.deposit != null && stats.rent != null && <p className="hint">서울 월세 거래 중간값은 보증금 {krwLabel(stats.deposit)} · 월세 {krwLabel(stats.rent)}이에요.</p>}
              {jeonse && stats.jeonse != null && <p className="hint">서울 전세 거래 중간값은 {krwLabel(stats.jeonse)}이에요.</p>}
              {examples}

              <fieldset className="priority-fields">
                <legend>무엇이 중요한가요</legend>
                <div className="chip-row" role="group" aria-label="상황 선택">{presets.map(p => <button type="button" key={p.id} className="chip" aria-pressed={preset === p.id} onClick={() => setWeights({ ...p.weights })}>{presetLabel(p.id, jeonse, p.name)}</button>)}</div>
              </fieldset>

              <button type="button" className={`filter-toggle ${filtersOpen ? 'on' : ''}`} aria-expanded={filtersOpen} aria-controls="filters" onClick={() => { setShowCustom(!filtersOpen); setShowLocation(!filtersOpen) }}><SlidersHorizontal size={15} aria-hidden="true" />더 자세히: 항목별 중요도 · 구 · 학교·직장 근처{filterCount > 0 && <span className="count">{filterCount}</span>}<ChevronDown className={filtersOpen ? 'rotated' : ''} size={15} aria-hidden="true" /></button>
              {filtersOpen && <div className="filters" id="filters">
                <section aria-labelledby="weights-title">
                  <h3 id="weights-title">항목별 중요도</h3>
                  <div className="levels">{domains.map(k => {
                    const Icon = icons[k]; const current = levelOf(weights[k] ?? 0)
                    return <fieldset key={k} className="level-row">
                      <legend><Icon size={15} aria-hidden="true" />{weightLabels[k]}<small>반영 {Math.round(normalized.weights[k] * 100)}%</small></legend>
                      <div className="seg seg-block level-options">{levels.map(l => <label key={l.id} className={current === l.id ? 'selected' : ''}><input type="radio" name={`level-${k}`} value={l.id} checked={current === l.id} onChange={() => setWeights(w => ({ ...w, [k]: l.value }))} />{l.label}</label>)}</div>
                    </fieldset>
                  })}</div>
                </section>
                <section aria-labelledby="district-title">
                  <h3 id="district-title">구로 좁히기</h3>
                  <DistrictPicker value={districts} onChange={setDistricts} idPrefix="panel-district" />
                </section>
                <section aria-labelledby="location-title">
                  <h3 id="location-title">학교·직장 근처로 좁히기</h3>
                  <LocationPicker areas={snapshot.areas} value={locationFilter} radiusKm={radiusKm} picking={pickingLocation} onRadius={setRadiusKm} onChange={changeLocation} onPick={() => setPickingLocation(!pickingLocation)} />
                </section>
              </div>}

              {error && <p className="field-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-block" disabled={dataState === 'loading' || loading}>{dataState === 'loading' ? '데이터 불러오는 중' : result ? '이 조건으로 다시 찾기' : '동네 찾기'}</button>
              <p className="hint center">예산에 맞는 거래가 10건 이상인 동네 중 최대 3곳을 추천해요. 동네 전체 중간값은 주거비 점수에 반영해요.</p>
            </form>}
          </section>

          <p className="sr-only" aria-live="polite">{announce}</p>
          {notice && <p className="notice" role="status"><Info size={15} aria-hidden="true" />{notice}</p>}
          {pendingNote && <p className="notice warn" role="status"><Info size={15} aria-hidden="true" />{pendingNote}</p>}
          {stale && <p className="notice" role="status"><Info size={15} aria-hidden="true" />데이터를 만든 지 45일이 넘었어요. 최신 상황과 다를 수 있어요.</p>}

          {!result ? <section className="how" aria-labelledby="how-title">
            <h2 id="how-title">이렇게 비교해요</h2>
            <dl>{domains.map(k => { const Icon = icons[k]; return <div key={k}><dt><Icon size={15} aria-hidden="true" />{weightLabels[k]}</dt><dd>{k === 'housing' && jeonse ? '전세 예산에 맞는 집이 많은지' : weightHints[k]}</dd></div> })}</dl>
          </section> : <section className="results" aria-labelledby="results-title">
            <div className="results-head">
              <h2 id="results-title" tabIndex={-1} ref={resultHeading}>{resultJeonse ? '전세' : '월세'} 추천 동네</h2>
              {result.recommendations.length > 0 && <div className="result-actions">
                {canSpeak && <button type="button" className="btn btn-secondary btn-sm" onClick={speak} aria-pressed={speaking}>{speaking ? <Square size={13} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}{speaking ? '멈추기' : '읽어주기'}</button>}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void share()}><Share2 size={13} aria-hidden="true" />공유</button>
              </div>}
            </div>
            {result.order !== 'budget-fit' && result.recommendations.length > 1 && <p className="stability-line" aria-live="polite"><Scale size={14} aria-hidden="true" />{stableLine ?? '비중을 조금 바꿔도 결과가 유지되는지 확인하는 중이에요…'}</p>}
            {result.recommendations.length > 0 && extraWarnings.map(w => <p key={w} className="notice"><Info size={15} aria-hidden="true" />{w}</p>)}
            {result.recommendations.length > 0 && <label className="result-sort">추천 정렬 <select value={result.order ?? 'score'} onChange={e => {
              const next = e.target.value as RecommendationOrder
              setOrder(next)
              apply(recommend(scopedSnapshot, result.budget, result.effectiveWeights, result.locationFilter, next), 'manual')
            }}><option value="score">종합 점수순</option><option value="budget-fit">예산 적합 비율순</option></select></label>}
            {result.recommendations.length > 0 && <ol className="rec-list">{result.recommendations.map(r => <ResultCard key={r.area.code} r={r} jeonse={resultJeonse} emph={emphasisOf(result.effectiveWeights)} change={rankChange(r)} wobble={stable && stable.drops[r.area.code] ? { drops: stable.drops[r.area.code], total: stable.total, instead: stable.instead[r.area.code] } : null} distanceKm={result.locationFilter ? distanceM(r.area, result.locationFilter) / 1000 : undefined} onOpen={() => openArea(r.area.code)} />)}</ol>}
            {result.recommendations.length > 0 && <p className="rec-basis">가격은 지난 계약의 중간값, 걷는 시간과 시설 수는 동 대표점 기준이에요.{emphasisOf(result.effectiveWeights).length > 0 && ' 굵게 표시한 줄은 내가 중요하게 고른 항목이에요.'}</p>}
            {result.recommendations.length > 0 && <section className="ai-box" aria-labelledby="ai-title" aria-busy={!aiExplain || aiExplain.status === 'loading'}>
              <h3 id="ai-title"><Sparkles size={15} aria-hidden="true" />AI 비교 설명</h3>
              {(!aiExplain || aiExplain.status === 'loading') && <p className="ai-status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{result.recommendations.length}곳의 수치를 비교해 정리하는 중이에요…</p>}
              {aiExplain?.status === 'error' && <p className="ai-status error" role="alert">{aiExplain.error}</p>}
              {aiExplain?.status === 'done' && aiExplain.data && <div aria-live="polite">
                <p className="ai-status">{aiExplain.data.source === 'fallback' ? aiExplain.data.notice : 'AI가 작성하고 수치·순위를 검사한 설명이에요.'}</p>
                <p className="ai-summary">{aiExplain.data.summary}</p>
                <ol className="ai-areas">{aiExplain.data.areas.map(a => <li key={a.rank}>
                  <p className="ai-head"><b>{a.rank}위 {result.recommendations.find(r => r.rank === a.rank)?.area.name ?? ''}</b>{a.headline}</p>
                  <ul>{a.pros.map(t => <li key={`p-${t}`} className="pro"><span className="ai-tag">좋은 점</span>{t}</li>)}{a.cons.map(t => <li key={`c-${t}`} className="con"><span className="ai-tag">아쉬운 점</span>{t}</li>)}</ul>
                </li>)}</ol>
                {aiExplain.data.tip && <p className="ai-tip"><Info size={14} aria-hidden="true" />{aiExplain.data.tip}</p>}
              </div>}
              <p className="ai-note">AI가 위 수치만 근거로 정리한 설명이에요. 점수와 순위는 정해진 규칙으로 계산해요.</p>
            </section>}
            {result.recommendations.length > 0 && suggestions?.radius && <div className="suggest"><p>반경을 {suggestions.radius.km}km로 넓히면 {suggestions.radius.count}곳까지 비교할 수 있어요.</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => setRadiusKm(suggestions.radius!.km)}>{suggestions.radius.km}km로 넓히기</button></div>}
            {!result.recommendations.length && <div className="empty"><h3>지금 조건으로는 비교할 동네가 없어요</h3><p>예산에 맞는 거래 10건 이상과 중간값 조건을 충족하는 동네가 {locationFilter ? '반경 안에 ' : ''}없어요. 아래 조건으로 바꾸면 추천이 나와요.</p>
              {(suggestions?.budget || suggestions?.radius) ? <div className="empty-actions">
                {suggestions.budget && <button type="button" className="btn btn-primary btn-sm" onClick={() => applyBudget(suggestions.budget!.deposit, suggestions.budget!.rent)}>{suggestions.budget.label}으로 찾기</button>}
                {suggestions.radius && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRadiusKm(suggestions.radius!.km)}>반경 {suggestions.radius.km}km로 넓히기</button>}
              </div> : <p>{resultJeonse ? '전세 보증금' : '보증금이나 월세'} 상한을 높여 보세요.</p>}
            </div>}
            {result.recommendations.length > 0 && <NextSteps />}
            {result.recommendations.length > 1 && <CompareTable recs={result.recommendations} jeonse={resultJeonse} emph={emphasisOf(result.effectiveWeights)} />}
            {excludedGroups.length > 0 && <details className="fold exclusions"><summary>추천에서 빠진 동네 {result.excluded.length}곳<span className="fold-meta">{excludedGroups.map(([key, items]) => `${reasonShort[key]} ${items.length}`).join(' · ')}</span><ChevronDown size={15} aria-hidden="true" /></summary>
              {excludedGroups.map(([key, items]) => <ExclusionGroup key={key} title={reasonTitles[key]} items={items} showNames={key !== 'radius'} onPick={pickArea} />)}
            </details>}
            {snapshot.warnings.length > 0 && <details className="fold"><summary>이 결과의 한계<ChevronDown size={15} aria-hidden="true" /></summary><ul className="fold-list">{snapshot.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>}
          </section>}
          <p className="panel-foot"><CircleHelp size={14} aria-hidden="true" />동네 선택의 출발점이에요. 최종 결정 전 현장과 최신 정보를 직접 확인해 주세요. <button type="button" onClick={openGuide}>데이터 안내</button></p>
        </>}
      </aside>

      <div className="map-column">
        <Suspense fallback={<div className="map-loading" aria-hidden="true" />}><SeoulMap areas={nearbyAreas} recommendations={result?.recommendations ?? noRecommendations} selected={selected} onSelect={mapSelect} location={locationFilter} picking={pickingLocation} excluded={excludedCodes} onPickLocation={(latitude, longitude) => changeLocation({ name: '지도에서 고른 위치', latitude, longitude, radiusKm })} checking={checking} checkPoint={checkPoint} checkRep={checkRep} onCheck={(latitude, longitude) => setCheckPoint({ latitude, longitude, name: '지도에서 찍은 위치' })} /></Suspense>
        <button type="button" className={`map-check ${checking ? 'on' : ''}`} aria-pressed={checking} onClick={() => checking ? closeCheck() : openCheck()}><Crosshair size={16} aria-hidden="true" />{checking ? '위치 찍기 끝내기' : '위치 찍어 보기'}</button>
        <div className="map-search"><AreaSearch areas={snapshot.areas} recent={recentAreas} onSelect={pickArea} compact /></div>
        {districts.length > 0 && !locationFilter && <div className="map-chip location-summary"><MapPin size={14} aria-hidden="true" /><span><strong>{districtLabel(districts)}</strong> 안 · 동네 {nearbyAreas.length}곳</span></div>}
        {locationFilter && <div className="map-chip location-summary"><MapPin size={14} aria-hidden="true" /><span><strong>{locationFilter.name}</strong> 주변 {radiusKm}km · 동네 {nearbyAreas.length}곳</span></div>}
      </div>
    </main>}

    {showData && <div className="sheet-layer" onMouseDown={e => { if (e.target === e.currentTarget) setShowData(false) }}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <div className="sheet-head"><h2 id="guide-title">데이터 출처와 계산 방법</h2><button type="button" id="guide-close" className="btn btn-icon" aria-label="데이터 안내 닫기" onClick={() => setShowData(false)}><X size={18} aria-hidden="true" /></button></div>
        <div className="sheet-body">
          <p className="sheet-lede">{dataState === 'loading' ? '데이터를 불러오는 중이에요.' : snapshot.isDemo ? '지금은 체험 데이터예요. 점수와 거래는 가상 값이에요.' : <>{date(snapshot.periodStart)} ~ {date(snapshot.periodEnd)}에 계약된 서울 전월세 실거래{stats.total ? ` ${totalLabel}` : ''}과 공공시설 데이터로 비교해요. 지금 나와 있는 매물은 아니에요.</>}</p>
          {import.meta.env.DEV && <div className="data-mode-row"><label htmlFor="data-mode">데이터 모드 (개발용)</label><select id="data-mode" value={loadedRemote ? 'supabase' : loadedLocal ? 'local' : 'demo'} disabled={loading} onChange={e => void changeData(e.target.value)}><option value="local">서울 전체 실제 집계 데이터</option><option value="demo">로컬 체험 데이터</option><option value="supabase">Supabase 스냅샷 {supabaseConfigured ? '' : '(연결 필요)'}</option></select><span>{loading ? '불러오는 중…' : supabaseConfigured ? 'Supabase 설정됨' : '로컬 모드'}</span></div>}
          <section><h3>어떻게 비교하나요?</h3><p>다섯 가지 항목(안전시설, 치안, 교통, 주거비, 병원·약국)을 0~100점으로 바꾼 뒤, 고른 상황에 맞춰 비중을 곱해 더합니다. 안전·교통·의료는 서울 전체 동네 대표점의 관측값 순위를 0~100점으로 바꾼 백분위 점수예요. 같은 관측값은 같은 점수이며, 교통은 역까지 보행 경로가 확인된 동네끼리 비교합니다. 주거비는 내 예산에 맞는 거래 비율 60%와 거래 중간값 대비 예산 여유 40%로 계산합니다.</p><p>월세는 보증금·월세 상한을 모두 충족한 거래, 전세는 보증금 상한을 충족한 거래가 10건 이상 있는 동네만 비교합니다. 동네 전체 거래 중간값은 후보 제외 조건으로 쓰지 않고 주거비 점수에만 반영합니다. 중간값이 예산을 넘으면 예산 여유 점수는 0점입니다. 필요한 정보가 없는 동네는 0점으로 바꾸지 않고 비교에서 뺍니다. 점수가 같으면 예산 적합 비율, 거래 수 순으로 정렬합니다.</p><p>AI(Groq)는 말로 찾기에서 말을 조건으로 바꾸고, 추천 세 곳을 쉬운 말로 비교하고, 화면을 말로 안내하는 데만 써요. 점수와 순위 계산에는 AI를 쓰지 않아 같은 조건이면 항상 같은 결과가 나와요.</p></section>
          <section><h3>참고할 때 알아두세요</h3><p>실거래 기록은 지금 구할 수 있는 매물이 아닙니다. 안전시설 점수는 공개된 CCTV·안심벨·보안등 등의 접근성이며 원천별 조사일·범위가 다릅니다. 안심귀갓길 자료는 {safetyYear(snapshot)}년 조사이며 서울 전체 안전시설 목록이 아닙니다. 시설 개수는 실제 안전한 정도나 범죄 확률을 뜻하지 않습니다. 역까지 걷는 시간은 보행 도로망 최단거리로 계산한 추정치이며 신호 대기·공사·휠체어 접근성은 반영하지 않습니다. 의료기관 공시 운영시간은 현재 영업 여부를 보장하지 않습니다.</p><p>지도 경계는 {snapshot.sources.find(s => s.id === 'boundary')?.name ?? '참고용 법정동 경계'}를 사용합니다. 실제 집 위치나 최신 행정동을 대신하지 않습니다.</p></section>
          <section><h3>사용한 데이터</h3><ul className="source-list">{snapshot.sources.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noreferrer"><span>{s.name}<small>{s.provider} · {s.license} · 기준 {s.observedDate} · 수집 {date(s.retrievedAt)}</small></span><ArrowUpRight size={14} aria-hidden="true" /></a></li>)}</ul></section>
          <p className="snapshot-meta"><span>스냅샷 {snapshot.id}</span><span>모델 {snapshot.modelVersion}</span><span>생성 {date(snapshot.createdAt)}</span><span>공간 단위 {snapshot.spatialUnit}</span></p>
        </div>
      </aside>
    </div>}
  </div>
}

/** AI 비교 설명에 보낼 값: 화면에 이미 있는 수치만 보낸다(개인 정보 없음). */
function explainBody(res: Results, priority: string, ds: string[]) {
  const j = res.budget.leaseType === 'jeonse'
  const n = (v: number | undefined, f: (x: number) => number = x => Math.round(x)) => v != null && Number.isFinite(v) ? f(v) : null
  return {
    conditions: {
      budget: j ? `전세 보증금 ${krwLabel(res.budget.maxDepositKrw)} 이하` : `보증금 ${krwLabel(res.budget.maxDepositKrw)} · 월세 ${krwLabel(res.budget.maxMonthlyRentKrw)} 이하`,
      priority, place: res.locationFilter?.name ?? null, radiusKm: res.locationFilter?.radiusKm ?? null, area: ds.length ? ds.join(', ') : null,
    },
    recs: res.recommendations.map(r => {
      const m = r.area.metrics ?? {}
      return {
        rank: r.rank, name: r.area.name, district: r.area.district, total: Math.round(r.totalScore),
        scores: Object.fromEntries(domains.map(k => [k, Math.round(r.componentScores[k] ?? 0)])),
        matchPct: Math.round(r.matchRatio * 1000) / 10, matchCount: r.budgetMatchCount, sampleCount: r.sampleCount,
        medianRentManwon: j ? null : Math.round(r.medianRentKrw / 10000), medianDepositManwon: j ? n(r.medianDepositKrw, x => Math.round(x / 10000)) : null,
        walkMin: walkMinutes(r.area), busM: n(m.busDistanceM), safety500m: n(m.observedSafety500m), cctv500m: n(m.observedCctv500m),
        hospitals500m: n(m.hospitals500m), pharmacies500m: n(m.pharmacies500m), nightPharmacies1km: n(m.nightPharmacies1000m),
        emergencyKm: n(m.emergencyDistanceM, x => Math.round(x / 100) / 10),
        distanceKm: res.locationFilter ? Math.round(distanceM(r.area, res.locationFilter) / 100) / 10 : null,
      }
    }),
  }
}

/** 안전시설 자료의 조사 연도(스냅샷 출처의 현장 기준일) */
function safetyYear(snapshot: Snapshot) { return snapshot.sources.find(s => s.id === 'safety')?.observedDate?.slice(0, 4) || '2022' }

/** 안전시설 점수 바로 옆에 두는 한계 안내 */
function SafetyNote({ snapshot }: { snapshot: Snapshot }) {
  return <p className="score-note"><Info size={14} aria-hidden="true" /><span><b>안전시설 점수</b>는 {snapshot.sources.some(s => s.id === 'extra-cctv') ? '공공 방범 CCTV와 기존 안심귀갓길 시설의 접근성이에요. 원천별 기준일은 출처에서 확인하세요.' : `안심귀갓길 CCTV·안심벨 등이 가까이 많은지예요(${safetyYear(snapshot)}년 조사).`} 실제로 안전한 정도나 범죄 위험을 뜻하지 않아요. <b>치안 점수</b>는 자치구 전체 범죄 발생률을 서울 25개 구와 비교한 값이에요. 같은 구의 동네에는 같은 값이 적용돼요.</span></p>
}

function ScoreBadge({ score }: { score: number }) {
  const stars = Math.max(1, Math.min(5, Math.ceil(score / 20)))
  return <span className="score-badge" aria-label={`종합 ${Math.round(score)}점, 5점 만점에 ${stars}등급`}>
    <b aria-hidden="true">{Math.round(score)}</b>
    <span className="stars" aria-hidden="true">{[1, 2, 3, 4, 5].map(i => <Star key={i} size={11} className={i <= stars ? 'on' : ''} />)}</span>
  </span>
}

function TermHelp() {
  return <details className="term-help">
    <summary><CircleHelp size={14} aria-hidden="true" />용어 풀이</summary>
    <dl>
      <div><dt>보증금</dt><dd>계약할 때 집주인에게 맡기고, 나갈 때 돌려받는 돈이에요.</dd></div>
      <div><dt>월세</dt><dd>보증금과 별도로 매달 내는 집세예요.</dd></div>
      <div><dt>전세</dt><dd>목돈을 맡기고 매달 집세 없이 사는 방식이에요. 계약이 끝나면 돌려받아요.</dd></div>
      <div><dt>중간값</dt><dd>거래를 금액 순으로 세웠을 때 한가운데 값이에요. 평균보다 극단값의 영향을 덜 받아요.</dd></div>
    </dl>
  </details>
}

function ResultCard({ r, jeonse, emph, change, wobble, distanceKm, onOpen }: { r: Recommendation; jeonse: boolean; emph: Domain[]; change: { cls: string; text: string } | null; wobble: { drops: number; total: number; instead: string | null } | null; distanceKm?: number; onOpen: () => void }) {
  return <li id={`card-${r.area.code}`}>
    <button type="button" className="rec-card" onClick={onOpen} onMouseEnter={() => linkPin(r.area.code, true)} onMouseLeave={() => linkPin(r.area.code, false)} onFocus={() => linkPin(r.area.code, true)} onBlur={() => linkPin(r.area.code, false)}>
      <span className={`rank-mark ${r.rank === 1 ? 'top' : ''}`} aria-hidden="true">{r.rank}</span>
      <span className="rec-main">
        <span className="rec-name"><span className="sr-only">{r.rank}위 </span>{r.area.name}{change && <span className={`rank-change ${change.cls}`}>{change.text}</span>}</span>
        <span className="meta">{r.area.district}{distanceKm != null ? ` · 기준 위치에서 ${distanceKm.toFixed(1)}km` : ''}</span>
        <span className="rec-reason">{reasonFor(r)}</span>
        <span className={`budget-coverage ${r.matchRatio < .3 ? 'sparse' : ''}`}>예산 적합 {(r.matchRatio * 100).toFixed(1)}% · {r.budgetMatchCount.toLocaleString('ko-KR')} / {r.sampleCount.toLocaleString('ko-KR')}건{r.matchRatio < .3 && ' · 예산에 맞는 계약이 드문 편이에요'}</span>
        <span className="hint">예산에 맞는 계약 중간값: 보증금 {krwLabel(r.matchedMedianDepositKrw ?? 0)}{!jeonse && ` · 월세 ${krwLabel(r.matchedMedianRentKrw ?? 0)}`}</span>
        <span className="rec-facts">{cardFacts(r, jeonse).map(f => <span key={f.label} className={`rec-fact ${emph.includes(f.key) ? 'emph' : ''}`}><span className="rf-label">{f.label}{emph.includes(f.key) && <span className="sr-only"> (중요하게 고른 항목)</span>}</span><span className="rf-value">{f.value}</span></span>)}</span>
        {wobble && <span className="wobble"><Scale size={13} aria-hidden="true" />비중을 조금 바꾸면 빠질 수 있어요 ({wobble.total}가지 중 {wobble.drops}가지){wobble.instead ? ` · 대신 ${wobble.instead}` : ''}</span>}
        <span className="rec-foot"><span className="rec-more">리포트 보기<ChevronRight size={14} aria-hidden="true" /></span></span>
      </span>
      <ScoreBadge score={r.totalScore} />
    </button>
  </li>
}

/** 목록 카드와 지도 핀을 함께 표시한다(다시 그리지 않고 표시만 바꾼다). */
function linkPin(code: string, on: boolean) {
  document.querySelectorAll(`.map-pin[data-code="${code}"]`).forEach(el => el.classList.toggle('linked', on))
}

function AreaReport({ area, rec, result, snapshot, leaseType, note, onBack, onCheck }: { area: Area; rec?: Recommendation; result: Results | null; snapshot: Snapshot; leaseType: LeaseType; note: string; onBack: () => void; onCheck: () => void }) {
  const facts = lifeFacts(area)
  const jeonse = (result?.budget.leaseType ?? leaseType) === 'jeonse'
  const lines = rec ? fitLines(rec, jeonse) : null
  const min = walkMinutes(area)
  const sampleCount = (jeonse ? area.jeonseGroups : area.rentalGroups)?.reduce((n, g) => n + g.count, 0) ?? area.transactions.filter(t => t.leaseType === (jeonse ? 'jeonse' : 'monthly')).length
  return <article className="report" aria-labelledby="report-title">
    <button type="button" className="btn btn-ghost btn-sm back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />{result ? '추천 목록으로' : '목록으로'}</button>
    <header className="report-head">
      {rec && <span className={`rank-mark ${rec.rank === 1 ? 'top' : ''}`} aria-hidden="true">{rec.rank}</span>}
      <div className="report-title">
        <h2 id="report-title" tabIndex={-1}>{rec && <span className="sr-only">{rec.rank}위 </span>}{area.name}</h2>
        <p className="meta">{area.district}{min != null ? ` · 역까지 걸어서 ${min}분` : ''}</p>
      </div>
      {rec && <ScoreBadge score={rec.totalScore} />}
    </header>
    {!rec && note && <p className="notice">{note}</p>}
    {rec && <p className="report-reason">{reasonFor(rec)}</p>}
    {rec && rec.matchRatio < .3 && <p className="notice warn">예산에 맞는 계약이 드문 편이에요. 전체 계약 중 {(rec.matchRatio * 100).toFixed(1)}%가 예산에 맞았어요.</p>}
    {lines && <div className="fit-lines"><p><b>이런 분께 맞아요</b>{lines.fit}</p>{lines.check && <p><b className="warn">확인해 보세요</b>{lines.check}</p>}</div>}
    {rec && <section className="report-block" aria-labelledby="r-scores"><h3 id="r-scores">항목별 점수</h3><ScoreBars scores={rec.componentScores} only={uiOrder} emph={result ? emphasisOf(result.effectiveWeights) : []} /><SafetyNote snapshot={snapshot} /></section>}
    <section className="report-block" aria-labelledby="r-price"><h3 id="r-price">시세 (최근 계약 기준)</h3>
      <dl className="price-list">
        {rec && <div><dt>{jeonse ? '동네 전세 보증금 중간값' : '동네 월세 중간값'}</dt><dd>{krwLabel(jeonse ? rec.medianDepositKrw ?? 0 : rec.medianRentKrw)}</dd></div>}
        {rec && <div><dt>예산 충족 계약 보증금 중간값</dt><dd>{krwLabel(rec.matchedMedianDepositKrw ?? 0)}</dd></div>}
        {rec && !jeonse && <div><dt>예산 충족 계약 월세 중간값</dt><dd>{krwLabel(rec.matchedMedianRentKrw ?? 0)}</dd></div>}
        {rec && <div><dt>내 예산에 맞는 거래</dt><dd>{rec.budgetMatchCount.toLocaleString('ko-KR')} / {rec.sampleCount.toLocaleString('ko-KR')}건 · {oneInTen(rec.matchRatio)}</dd></div>}
        {!rec && <div><dt>이 동네 {jeonse ? '전세' : '월세'} 거래</dt><dd>{sampleCount.toLocaleString('ko-KR')}건</dd></div>}
      </dl>
      <p className="hint">신고된 실거래 기준 참고 시세예요. 지금 나와 있는 매물은 아니에요.</p>
    </section>
    <section className="report-block" aria-labelledby="r-life"><h3 id="r-life">생활 정보</h3>
      <ul className="life-facts">{facts.length
        ? facts.map(f => { const Icon = factIcons[f.key] ?? Info; return <li key={f.key}><Icon size={16} aria-hidden="true" />{f.text}</li> })
        : area.evidence.map(e => <li key={e.label}><Info size={16} aria-hidden="true" />{e.label}: {e.value}</li>)}</ul>
      <div className="rep-note"><p>위 정보는 동 대표점 한 곳에서 잰 값이에요. 실제 집 위치에 따라 달라질 수 있어요.</p><button type="button" className="btn btn-secondary btn-sm" onClick={onCheck}><Crosshair size={14} aria-hidden="true" />집 후보 자리 찍어 보기</button></div>
    </section>
    {rec && <NextSteps />}
    <details className="fold tech"><summary>계산 방법과 출처<ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="fold-body">
        {area.walking?.status === 'ok' && <p>역까지 도보: {Math.round(area.walking.distanceM ?? 0)}m, 보행 도로망 최단거리. 시작점 보정 {Math.round(area.walking.originSnapM ?? 0)}m · 도착점 보정 {Math.round(area.walking.destinationSnapM ?? 0)}m는 따로이며 시간은 추정치예요.</p>}
        {rec && <p>종합 {Math.round(rec.totalScore)}점. 주거비 점수는 {jeonse ? '전세' : '월세'} 예산 적합 비율 60% + 중간값 대비 예산 여유 40%예요.</p>}
        <dl>{area.evidence.map(e => <div key={e.label}><dt>{e.label}</dt><dd>{e.value}<small>{snapshot.sources.find(s => s.id === e.sourceId)?.name}</small></dd></div>)}</dl>
        {area.flags.map(f => <p key={f}>{f}</p>)}
        <p>{date(snapshot.periodStart)} ~ {date(snapshot.periodEnd)} · {snapshot.isDemo ? '가상 거래 기간 · 실제 수집 자료 아님' : `수집 ${date(snapshot.createdAt)}`} · {snapshot.modelVersion}</p>
      </div>
    </details>
  </article>
}

function CompareTable({ recs, jeonse, emph }: { recs: Recommendation[]; jeonse: boolean; emph: Domain[] }) {
  const count = (a: Area, key: string) => { const v = metric(a, key); return v != null ? `${v}곳` : '-' }
  // 카드·리포트와 같은 순서(주거비 → 교통 → 병원·약국 → 안전시설), 같은 단위
  const rows: { key: Domain; label: string; value: (r: Recommendation) => string }[] = [
    { key: 'housing', label: jeonse ? '전세 중간값' : '월세 중간값', value: r => krwLabel(jeonse ? r.medianDepositKrw ?? 0 : r.medianRentKrw) },
    { key: 'housing', label: '예산 맞는 집', value: r => oneInTen(r.matchRatio) },
    { key: 'transit', label: '역까지 도보', value: r => { const m = walkMinutes(r.area); return m != null ? `약 ${m}분` : '-' } },
    { key: 'medical', label: '500m 안 병·의원', value: r => count(r.area, 'hospitals500m') },
    { key: 'medical', label: '500m 안 약국', value: r => count(r.area, 'pharmacies500m') },
    { key: 'safety', label: '500m 안 안전시설', value: r => count(r.area, 'observedSafety500m') },
    { key: 'policing', label: '자치구 범죄율 (10만 명당)', value: r => r.area.crime ? `${r.area.crime.per100k.toFixed(1)}건 (${r.area.crime.year}년)` : '-' },
  ]
  return <details className="fold compare">
    <summary>{recs.length}곳 나란히 비교<ChevronDown size={15} aria-hidden="true" /></summary>
    <div className="table-wrap"><table>
      <caption className="sr-only">추천 동네 비교</caption>
      <thead><tr><th scope="col">항목</th>{recs.map(r => <th scope="col" key={r.area.code}>{r.rank}위 {r.area.name}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.label} className={emph.includes(row.key) ? 'emph' : ''}><th scope="row">{row.label}{emph.includes(row.key) && <span className="sr-only"> (중요하게 고른 항목)</span>}</th>{recs.map(r => <td key={r.area.code}>{row.value(r)}</td>)}</tr>)}</tbody>
    </table></div>
  </details>
}

const EXCLUSION_PREVIEW = 12
function ExclusionGroup({ title, items, showNames, onPick }: { title: string; items: ExcludedItem[]; showNames: boolean; onPick: (code: string) => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, EXCLUSION_PREVIEW)
  return <div className="exclusion-group">
    <h4>{title} <small>{items.length}곳</small></h4>
    {showNames ? <>
      <ul className="exclusion-chips">{shown.map(i => <li key={i.area.code}><button type="button" className="chip" onClick={() => onPick(i.area.code)}>{i.area.district} {i.area.name}{i.count != null && <small> · 거래 {i.count}건</small>}</button></li>)}</ul>
      {items.length > EXCLUSION_PREVIEW && <button type="button" className="btn btn-ghost btn-sm more" onClick={() => setAll(!all)}>{all ? '접기' : `${items.length - EXCLUSION_PREVIEW}곳 더 보기`}</button>}
    </> : <p className="exclusion-note">학교·직장 기준 반경을 넓히면 비교에 들어와요.</p>}
  </div>
}

function NextSteps() {
  return <section className="next-steps" aria-labelledby="next-steps-title">
    <h3 id="next-steps-title"><ListChecks size={18} aria-hidden="true" />계약 전에 이것만은 확인하세요</h3>
    <p className="next-lede">추천은 지난 계약 기록으로 고른 동네예요. 지금 그 가격의 집이 있다는 뜻은 아니니, 마음에 드는 집을 찾으면 아래 세 가지를 꼭 확인하세요.</p>
    <ol role="list">
      <li><span>밤 시간에 집에서 지하철역까지 직접 걸어 보세요.</span></li>
      <li><span>계약 전에 등기부등본으로 집주인과 빚(근저당)이 있는지 확인하세요.</span></li>
      <li><span>서울시 <a href={SEOUL_HOUSING_HELP} target="_blank" rel="noreferrer">1인가구 전월세 안심계약 도움서비스<ArrowUpRight size={14} aria-hidden="true" /></a>에서 무료 상담과 집보기 동행을 받을 수 있어요.</span></li>
    </ol>
  </section>
}
