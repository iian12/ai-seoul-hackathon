import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { resolve, relative, isAbsolute } from 'node:path'

export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function packagePath(root, path) {
  const full = resolve(root, path), rel = relative(resolve(root), full)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('invalid_package_path')
  return full
}
export async function* batches(root, source) {
  let rows = [], start = 1
  // Batch boundaries are deterministic across retries and chunk files.
  for (const chunk of source.chunks) {
    const path = packagePath(root, chunk.path)
    const zipped = await readFile(path)
    if (zipped.length !== chunk.bytes || hash(zipped) !== chunk.sha256) throw new Error('row_chunk_changed')
    const input = createReadStream(path)
    const unzip = createGunzip()
    input.on('error', e => unzip.destroy(e))
    const lines = createInterface({ input: input.pipe(unzip), crlfDelay: Infinity })
    let count = 0
    try {
      for await (const line of lines) {
        JSON.parse(line) // Validate syntax; transmit original numeric tokens without JS round-off.
        rows.push(line); count++
        if (rows.length === 500) {
          yield { start, count: rows.length, json: `[${rows.join(',')}]`, sha256: hash(`[${rows.join(',')}]`) }
          start += rows.length; rows = []
        }
      }
    } finally { lines.close(); input.destroy(); unzip.destroy() }
    if (count !== chunk.rows) throw new Error('row_chunk_count_changed')
  }
  if (rows.length) yield { start, count: rows.length, json: `[${rows.join(',')}]`, sha256: hash(`[${rows.join(',')}]`) }
}
export async function retry(operation, attempts = 4) {
  for (let i = 0; ; i++) {
    try { return await operation() }
    catch { if (i >= attempts - 1) throw new Error('remote_operation_failed'); await new Promise(r => setTimeout(r, 500 * (i + 1))) }
  }
}
export async function importSource(root, source, state, rpc, progress = () => {}) {
  if (state.records_sha256 !== source.recordsSha256 || Number(state.expected_rows) !== source.rows) throw new Error('remote_source_conflict')
  let loaded = Number(state.loaded_rows)
  if (!Number.isSafeInteger(loaded) || loaded < 0 || loaded > source.rows) throw new Error('invalid_remote_checkpoint')
  for await (const batch of batches(root, source)) {
    const end = batch.start + batch.count - 1
    if (end <= loaded) continue
    if (batch.start !== loaded + 1) throw new Error('remote_checkpoint_not_on_batch_boundary')
    const next = Number(await retry(() => rpc('housing_import_raw_batch', { p_source_id: state.id, p_start_row: batch.start, p_rows_json: batch.json, p_sha256: batch.sha256 })))
    if (next !== end) throw new Error('concurrent_import_or_count_mismatch')
    loaded = next
    if (loaded % 10000 === 0 || loaded === source.rows) progress(loaded)
  }
  const actual = Number(await retry(() => rpc('housing_finish_raw_source', { p_source_id: state.id })))
  if (actual !== source.rows) throw new Error('remote_source_count_mismatch')
  return actual
}
