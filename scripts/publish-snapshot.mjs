import { readFile, writeFile, mkdir, mkdtemp, rename, rm, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { validateSnapshot } from '../src/lib/recommend.ts'
import { preparePointData } from './point-enrichment.mjs'

export async function readPublishedSnapshot(root = 'public/data') {
  try {
    const release = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
    return JSON.parse(await readFile(join(root, release.snapshot.replace('/data/', '')), 'utf8'))
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  return JSON.parse(await readFile(join(root, 'seoul-snapshot.json'), 'utf8'))
}
async function verifySource(snapshotFile, reportFile) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/validate-seoul-snapshot.ts'], { stdio: 'inherit', env: { ...process.env, SNAPSHOT_FILE: resolve(snapshotFile), ...(reportFile ? { AGGREGATION_REPORT_FILE: resolve(reportFile) } : {}) } })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? accept() : reject(new Error('원천 대조 검증 실패: 현재 공개 버전을 유지합니다.')))
  })
}

export function validateWalkingBundle(snapshot, point, walk) {
  const g = point.walkGrid, n = g.rows * g.cols
  if (![g.rows, g.cols].every(v => Number.isSafeInteger(v) && v > 0) || ![g.lat0, g.lon0, g.dLat, g.dLon, g.stepM].every(Number.isFinite) || g.dLat <= 0 || g.dLon <= 0 || g.stepM <= 0 || !Array.isArray(point.stations) || !point.stations.length || walk.length !== n * 6) throw new Error('보행 격자 메타데이터·크기 오류')
  let positive = 0
  for (let i = 0; i < n; i++) {
    const m = walk.readUInt16LE(i * 2), seconds = walk.readUInt16LE((n + i) * 2), station = walk.readUInt16LE((2 * n + i) * 2)
    if (m === 65535) { if (seconds !== 65535 || station !== 65535) throw new Error('보행 결측 표식 오류'); continue }
    if (seconds === 65535 || station >= point.stations.length || seconds + 1 < m / 1.25) throw new Error('보행 시간·역 번호 오류')
    if (m > 0) positive++
  }
  if (!positive) throw new Error('유효한 보행 거리 없음')
  const confirmed = snapshot.areas.filter(a => a.walking?.status === 'ok')
  let matched = 0
  for (const area of confirmed) {
    const row = Math.floor((area.latitude - g.lat0) / g.dLat), col = Math.floor((area.longitude - g.lon0) / g.dLon)
    if (row < 0 || row >= g.rows || col < 0 || col >= g.cols) continue
    const meters = walk.readUInt16LE((row * g.cols + col) * 2)
    if (meters !== 65535 && Math.abs(meters - area.walking.distanceM) <= g.stepM * 4) matched++
  }
  if (confirmed.length && matched < confirmed.length * .9) throw new Error('대표점 경로와 보행 격자 불일치: 보행 자료를 다시 생성하세요.')
}

// Immutable files are prepared first. Readers observe only the atomic pointer switch.
export async function publishSnapshot(snapshot, { root = 'public/data', report, points, walkFile = join(root, 'point-walk.bin'), verify = verifySource } = {}) {
  snapshot = structuredClone(snapshot)
  const previousId = snapshot.id
  snapshot.id = `${snapshot.id.replace(/-release-[a-f0-9-]{36}$/, '')}-release-${randomUUID()}`
  validateSnapshot(snapshot)
  await mkdir(join(root, 'releases'), { recursive: true })
  const stage = await mkdtemp(join(root, 'releases', 'stage-'))
  try {
    if (points && points.snapshotId !== previousId) throw new Error('위치 점검 스냅샷 불일치')
    const point = points ? { ...structuredClone(points), snapshotId: snapshot.id } : await preparePointData(snapshot, join(root, 'point-facilities.json'))
    if (point.snapshotId !== snapshot.id) throw new Error('위치 점검 스냅샷 불일치')
    const normalization = snapshot.calculation?.normalization
    for (const key of ['safety', 'transit', 'medical']) if (JSON.stringify(point.normalization[key]) !== JSON.stringify(normalization?.[key])) throw new Error('위치 점검 점수 기준 불일치')
    const json = JSON.stringify(snapshot), gzip = gzipSync(json)
    if (gunzipSync(gzip).toString() !== json) throw new Error('압축 자료 불일치')
    await writeFile(join(stage, 'seoul-snapshot.json'), json)
    await writeFile(join(stage, 'seoul-snapshot.json.gz'), gzip)
    await writeFile(join(stage, 'point-facilities.json'), JSON.stringify(point))
    await copyFile(walkFile, join(stage, 'point-walk.bin'))
    const walk = await readFile(join(stage, 'point-walk.bin'))
    validateWalkingBundle(snapshot, point, walk)
    if (report) await writeFile(join(stage, 'aggregation-report.json'), JSON.stringify(report, null, 2))
    await verify(join(stage, 'seoul-snapshot.json'), report ? join(stage, 'aggregation-report.json') : undefined)
    const version = randomUUID(), dest = join(root, 'releases', version)
    await rename(stage, dest)
    // Compatibility copies for maintenance scripts and pre-manifest deployments.
    for (const file of ['seoul-snapshot.json', 'seoul-snapshot.json.gz', 'point-facilities.json']) {
      const temp = join(root, `${file}.${version}.tmp`)
      await copyFile(join(dest, file), temp); await rename(temp, join(root, file))
    }
    const base = `/data/releases/${version}/`
    const manifest = { version: 1, id: snapshot.id, snapshot: base + 'seoul-snapshot.json', gzip: base + 'seoul-snapshot.json.gz', points: base + 'point-facilities.json', walk: base + 'point-walk.bin' }
    const pointer = join(root, `current.${version}.tmp`)
    await writeFile(pointer, JSON.stringify(manifest)); await rename(pointer, join(root, 'current.json'))
    if (report) { await writeFile('data/full-seoul/aggregation-report.json.tmp', JSON.stringify(report, null, 2)); await rename('data/full-seoul/aggregation-report.json.tmp', 'data/full-seoul/aggregation-report.json') }
    return manifest
  } finally { await rm(stage, { recursive: true, force: true }) }
}
