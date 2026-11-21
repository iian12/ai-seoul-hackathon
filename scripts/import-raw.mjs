import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { hash, packagePath, retry, importSource } from './raw-import-lib.mjs'

const args = process.argv.slice(2)
const root = resolve(args.find(a => !a.startsWith('--')) || 'data-export/raw-v1')
const upload = args.includes('--upload')
if (args.some(a => a.startsWith('--') && a !== '--upload')) throw new Error('지원하는 옵션은 --upload입니다.')
console.log('로컬 패키지 전체 파일·레코드 검증을 시작합니다. 검증 전에는 원격 쓰기를 하지 않습니다.')
const check = spawnSync('python3', ['scripts/verify-raw.py', root], { stdio: 'inherit' })
if (check.status !== 0) process.exit(1)
const manifestBytes = await readFile(`${root}/manifest.json`)
const manifest = JSON.parse(manifestBytes)
console.log(JSON.stringify({ mode: upload ? 'full-upload' : 'dry-run', collection: manifest.id, ...manifest.stats, sourceCount: manifest.sources.length, archiveParts: manifest.archiveParts.length }, null, 2))
if (!upload) { console.log('준비 완료. 실제 적재: npm run raw:import -- --upload'); process.exit(0) }
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) { console.error('.env.server.local의 SUPABASE_URL / SUPABASE_SECRET_KEY를 설정하세요.'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(180000) }) } })
const bucket = db.storage.from('housing-raw')
async function checked(query) { const { data, error } = await query; if (error) throw new Error('remote_operation_failed'); return data }
const rpc = (name, params) => checked(db.rpc(name, params))
async function uploadObject(name, bytes, mime) {
  // Content-addressed collection paths; existing bytes are verified, never blindly overwritten.
  await retry(async () => {
    const { error } = await bucket.upload(name, bytes, { contentType: mime, upsert: false })
    if (error && !['409', '400'].includes(String(error.statusCode))) throw new Error('archive_upload_failed')
    // Also verifies a previous successful upload whose response was lost.
    const blob = await checked(bucket.download(name))
    if (hash(Buffer.from(await blob.arrayBuffer())) !== hash(bytes)) throw new Error('remote_archive_hash_mismatch')
  })
}
try {
  await retry(() => checked(db.from('housing_raw_collections').upsert({ id: manifest.id, manifest }, { onConflict: 'id', ignoreDuplicates: true })))
  for (const part of manifest.archiveParts) {
    const bytes = await readFile(packagePath(root, part.path))
    if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) throw new Error('archive_part_changed')
    await uploadObject(`${manifest.id}/${part.path}`, bytes, 'application/octet-stream')
    console.log(`원본 아카이브 업로드·다운로드 SHA256 확인: ${part.path}`)
  }
  await uploadObject(`${manifest.id}/manifest.json`, manifestBytes, 'application/json')
  await checked(db.from('housing_raw_collections').update({ archive_verified: true }).eq('id', manifest.id))
  for (const source of manifest.sources) {
    await retry(() => checked(db.from('housing_raw_sources').upsert({ collection_id: manifest.id, source_id: source.id, expected_rows: source.rows, records_sha256: source.recordsSha256 }, { onConflict: 'collection_id,source_id', ignoreDuplicates: true })))
    const state = await checked(db.from('housing_raw_sources').select('id,expected_rows,loaded_rows,records_sha256,state').eq('collection_id', manifest.id).eq('source_id', source.id).single())
    await importSource(root, source, state, rpc, count => console.log(`${source.id}: ${count.toLocaleString()}/${source.rows.toLocaleString()} rows`))
  }
  await rpc('housing_finish_raw_collection', { p_collection_id: manifest.id })
  console.log(`원천 전체 적재 및 건수 검증 완료: ${manifest.sources.length}개 원천, ${manifest.stats.rows.toLocaleString()}개 레코드. 공개 집계 스냅샷과 분리해 보관했습니다.`)
} catch {
  console.error('전체 적재 미완료. 마지막 정상 배치는 보존했습니다. 마이그레이션·프로젝트 용량·권한을 확인한 뒤 같은 명령으로 재시도하세요. 원격 오류 본문과 키는 출력하지 않습니다.')
  process.exitCode = 1
}
