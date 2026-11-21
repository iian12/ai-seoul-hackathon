// Local PostgreSQL storage sample. This is an estimate, not hosted quota verification.
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { packagePath } from './raw-import-lib.mjs'
const root = 'data-export/raw-v1'
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'))
const db = new PGlite()
try {
  await db.exec('create table sample(source_id bigint, row_no bigint, payload jsonb not null, primary key(source_id,row_no));')
  const sources = []
  for (const [i, source] of manifest.sources.entries()) {
    const selected = [...new Set([0, Math.floor(source.chunks.length / 2), source.chunks.length - 1])]
    const lines = []
    for (const index of selected) {
      const chunk = source.chunks[index]
      lines.push(...gunzipSync(await readFile(packagePath(root, chunk.path))).toString('utf8').trimEnd().split('\n').slice(0, 250))
    }
    const json = `[${lines.join(',')}]`
    await db.query('insert into sample select $1, ordinality, value from jsonb_array_elements($2::jsonb) with ordinality', [i, json])
    const { rows: [r] } = await db.query('select count(*)::int as rows, avg(pg_column_size(payload))::float8 as average_payload_bytes from sample where source_id=$1', [i])
    // Heap header + row columns + approximate B-tree entry; excludes database baseline.
    sources.push({ source: source.id, sampledRows: r.rows, averagePayloadBytes: r.average_payload_bytes, estimatedRowsWithIndexBytes: Math.ceil((r.average_payload_bytes + 88) * source.rows) })
  }
  const report = { method: 'Local PostgreSQL JSONB samples from first/middle/last source chunks, at most 750 rows/source; estimated per-row heap/index overhead 88 bytes; not actual hosted size', manifestId: manifest.id, rows: manifest.stats.rows, sampledRows: sources.reduce((n, s) => n + s.sampledRows, 0), estimatedRowsWithIndexBytes: sources.reduce((n, s) => n + s.estimatedRowsWithIndexBytes, 0), sources }
  await writeFile('docs/raw-db-size-estimate.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ sampledRows: report.sampledRows, estimatedRowsWithIndexBytes: report.estimatedRowsWithIndexBytes, note: 'Estimate only. Verify pg_total_relation_size after actual hosted import.' }, null, 2))
} finally { await db.close() }
