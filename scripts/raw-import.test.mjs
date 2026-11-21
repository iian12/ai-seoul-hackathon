import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { hash, importSource, packagePath } from './raw-import-lib.mjs'

test('Postgres: lossless raw values, atomic retries, resume, completion and private permissions', async () => {
  const db = new PGlite()
  const folder = await mkdtemp(join(tmpdir(), 'housing-raw-test-'))
  try {
    await db.exec("create role anon; create role authenticated; create role service_role; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);")
    await db.exec(await readFile('supabase/migrations/202611160003_full_raw.sql', 'utf8'))
    const id = 'a'.repeat(64), checksum = 'b'.repeat(64)
    await db.query('insert into housing_raw_collections(id,manifest) values ($1,$2)', [id, { id, sources: [{ id: 'raw' }] }])
    const state = (await db.query("insert into housing_raw_sources(collection_id,source_id,expected_rows,records_sha256) values ($1,'raw',1001,$2) returning *", [id, checksum])).rows[0]
    const lines = Array.from({ length: 1001 }, (_, i) => `{"row":${i},"large":9007199254740993,"empty":"","nullable":null,"GRFE":"-1","type":"전세"}`)
    const zipped = gzipSync(lines.join('\n') + '\n')
    await writeFile(join(folder, 'rows.gz'), zipped)
    const source = { rows: 1001, recordsSha256: checksum, chunks: [{ path: 'rows.gz', rows: 1001, bytes: zipped.length, sha256: hash(zipped) }] }
    const call = async (name, params) => {
      const keys = Object.keys(params)
      const result = await db.query(`select ${name}(${keys.map((_, i) => '$' + (i + 1)).join(',')}) as result`, Object.values(params))
      return result.rows[0].result
    }
    let lostResponse = false, injectedFailure = false
    const network = async (name, params) => {
      if (name === 'housing_import_raw_batch' && params.p_start_row === 501 && !injectedFailure) {
        injectedFailure = true
        throw new Error('connection lost before sending')
      }
      const result = await call(name, params)
      if (name === 'housing_import_raw_batch' && params.p_start_row === 1 && !lostResponse) { lostResponse = true; throw new Error('response lost after commit') }
      return result
    }
    assert.equal(Number(await importSource(folder, source, state, network)), 1001)
    assert.equal((await db.query('select count(*)::int as n from housing_raw_records')).rows[0].n, 1001)
    assert.equal((await db.query("select payload->>'large' as large, payload->>'GRFE' as deposit from housing_raw_records limit 1")).rows[0].large, '9007199254740993')
    assert.equal((await db.query("select payload->>'GRFE' as deposit from housing_raw_records limit 1")).rows[0].deposit, '-1')
    const saved = (await db.query('select * from housing_raw_sources')).rows[0]
    assert.equal(Number(await importSource(folder, source, saved, call)), 1001)
    assert.equal((await db.query('select count(*)::int as n from housing_raw_batches')).rows[0].n, 3)
    await assert.rejects(() => call('housing_import_raw_batch', { p_source_id: state.id, p_start_row: 1, p_rows_json: '[{}]', p_sha256: hash('[{}]') }), /batch_content_conflict/)
    await assert.rejects(() => call('housing_finish_raw_collection', { p_collection_id: id }), /collection_incomplete/)
    await db.query('update housing_raw_collections set archive_verified = true where id=$1', [id])
    await call('housing_finish_raw_collection', { p_collection_id: id })
    assert.equal((await db.query('select state from housing_raw_collections')).rows[0].state, 'complete')
    await db.exec('set role anon')
    await assert.rejects(() => db.query('select * from housing_raw_records'), /permission denied/)
    await db.exec('reset role')
    const permissions = (await db.query("select has_function_privilege('anon','housing_import_raw_batch(bigint,bigint,text,text)','execute') as allowed")).rows[0]
    assert.equal(permissions.allowed, false)
    await writeFile(join(folder, 'rows.gz'), Buffer.from('corrupt'))
    await assert.rejects(() => importSource(folder, source, state, call), /row_chunk_changed/)
    assert.throws(() => packagePath(folder, '../outside'), /invalid_package_path/)
  } finally { await db.close(); await rm(folder, { recursive: true, force: true }) }
})

test('Postgres rejects incomplete and out-of-order writes without leaving partial rows', async () => {
  const db = new PGlite()
  try {
    await db.exec("create role anon; create role authenticated; create role service_role; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);")
    await db.exec(await readFile('supabase/migrations/202611160003_full_raw.sql', 'utf8'))
    const id = 'd'.repeat(64)
    await db.query('insert into housing_raw_collections(id,manifest) values ($1,$2)', [id, { id, sources: [] }])
    const source = (await db.query("insert into housing_raw_sources(collection_id,source_id,expected_rows,records_sha256) values ($1,'s',2,$1) returning id", [id])).rows[0].id
    await assert.rejects(() => db.query('select housing_import_raw_batch($1,2,$2,$3)', [source, '[{}]', hash('[{}]')]), /batch_sequence/)
    await assert.rejects(() => db.query('select housing_import_raw_batch($1,1,$2,$3)', [source, '[{}]', id]), /batch_hash_mismatch/)
    await assert.rejects(() => db.query('select housing_import_raw_batch($1,1,$2,$3)', [source, '[{},null]', id]), /invalid_batch/)
    await assert.rejects(() => db.query('select housing_finish_raw_source($1)', [source]), /source_incomplete/)
    assert.equal((await db.query('select count(*)::int as n from housing_raw_records')).rows[0].n, 0)
  } finally { await db.close() }
})
