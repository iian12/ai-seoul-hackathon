import { validateSnapshot } from './recommend.ts'
import { loadRelease } from './data-release.ts'

// Resolve once so gzip and JSON fallback always belong to the same release.
export async function loadLocalSnapshot(signal?: AbortSignal, refresh = false): Promise<unknown> {
  const release = await loadRelease(signal, refresh)
  const options = { signal, ...(refresh ? { cache: 'no-store' as const } : {}) }
  const check = (value: unknown) => {
    validateSnapshot(value)
    if (release && value.id !== release.id) throw new Error('자료 버전이 일치하지 않아요.')
    return value
  }
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const res = await fetch(release?.gzip ?? '/data/seoul-snapshot.json.gz', options)
      if (!res.ok || !res.body || res.headers.get('content-type')?.includes('text/html')) throw new Error('압축 자료 없음')
      const body = res.headers.get('content-encoding') === 'gzip' ? res.body : res.body.pipeThrough(new DecompressionStream('gzip'))
      return check(await new Response(body).json())
    } catch (e) { if (signal?.aborted) throw e }
  }
  const res = await fetch(release?.snapshot ?? '/data/seoul-snapshot.json', options)
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error('서울 실제 집계 자료를 찾지 못했어요.')
  return check(await res.json())
}
