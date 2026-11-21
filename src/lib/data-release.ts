export interface DataRelease { version: 1; id: string; snapshot: string; gzip: string; points: string; walk: string }
export async function loadRelease(signal?: AbortSignal, refresh = false): Promise<DataRelease | null> {
  const res = await fetch('/data/current.json', { signal, cache: refresh ? 'no-store' : 'no-cache' })
  if (res.status === 404 || (res.ok && res.headers.get('content-type')?.includes('text/html'))) return null
  if (!res.ok) throw new Error('공개 데이터 버전을 확인하지 못했어요. 다시 시도해 주세요.')
  const d = await res.json() as DataRelease
  if (d.version !== 1 || typeof d.id !== 'string' || !['snapshot', 'gzip', 'points', 'walk'].every(k => typeof d[k as keyof DataRelease] === 'string' && /^\/data\/releases\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(String(d[k as keyof DataRelease])))) throw new Error('공개 데이터 버전 정보가 올바르지 않아요.')
  return d
}
