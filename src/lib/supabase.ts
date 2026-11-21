import { createClient } from '@supabase/supabase-js'
import { validateSnapshot } from './recommend.ts'
import type { Snapshot } from './types.ts'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
const looksPrivate = publicKey?.startsWith('sb_secret_') || (() => {
  try { return JSON.parse(atob(publicKey!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role' } catch { return false }
})()
export const supabaseConfigured = Boolean(url && publicKey && !looksPrivate)
export const supabase = supabaseConfigured ? createClient(url!, publicKey!, { auth: { persistSession: false, autoRefreshToken: false } }) : null

export async function loadSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  if (!supabase) throw new Error('Supabase 프로젝트 URL과 공개 키 설정이 필요합니다.')
  const query = supabase.from('housing_snapshots').select('payload').eq('published', true).order('created_at', { ascending: false }).limit(1)
  const { data, error } = await (signal ? query.abortSignal(signal) : query).single()
  if (error || !data?.payload) throw new Error('공개된 정상 스냅샷을 불러오지 못했습니다. Supabase 연결과 데이터 적재 상태를 확인해 주세요.')
  validateSnapshot(data.payload)
  return data.payload
}
