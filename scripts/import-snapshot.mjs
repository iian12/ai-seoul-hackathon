import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { validateSnapshot } from '../src/lib/recommend.ts'

const file = process.argv[2]
if (!file || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error('사용법: npm run snapshot:import -- data/snapshot.json\n.env.server.local에 SUPABASE_URL / SUPABASE_SECRET_KEY를 설정하세요.')
  process.exit(1)
}
let snapshot
try {
  snapshot = JSON.parse(await readFile(file, 'utf8'))
  validateSnapshot(snapshot)
  // Reject any known key in a snapshot before uploading public content.
  const body = JSON.stringify(snapshot)
  const secrets = ['DATA_GO_KR_SERVICE_KEY', 'SEOUL_OPEN_DATA_API_KEY', 'SAFEMAP_API_KEY', 'TDATA_API_KEY', 'SUPABASE_SECRET_KEY'].map(k => process.env[k]).filter(Boolean)
  if (secrets.some(secret => body.includes(secret) || body.includes(encodeURIComponent(secret)))) throw new Error('secret')
} catch {
  console.error('스냅샷 검증 실패. 서울 범위·출처·모델 버전·비밀키 포함 여부를 확인하세요. 기존 데이터는 유지됩니다.')
  process.exit(1)
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
try {
  // One INSERT is transactional; immutable IDs deliberately prevent accidental overwrite.
  const { error } = await db.from('housing_snapshots').insert({ id: snapshot.id, published: true, payload: snapshot }).abortSignal(AbortSignal.timeout(20000))
  if (error) throw new Error('import_failed')
  console.log(`스냅샷 저장 완료: ${snapshot.areas.length}개 서울 지역 · ${snapshot.isDemo ? '체험 데이터' : '원천 기반 데이터'}`)
} catch {
  console.error('저장 실패. 프로젝트 설정·마이그레이션·중복 ID를 확인하세요. 기존 정상 스냅샷은 유지됩니다.')
  process.exitCode = 1
}
