import { spawn } from 'node:child_process'
import { rename } from 'node:fs/promises'
for (const name of ['SEOUL_OPEN_DATA_API_KEY', 'DATA_GO_KR_SERVICE_KEY', 'TDATA_API_KEY']) if (!process.env[name]) { console.error(`서버 환경변수 ${name}가 필요합니다.`); process.exit(1) }
if (process.argv.includes('--refresh')) {
  const stamp = Date.now()
  for (const path of ['data/full-seoul', 'data/current-year-bulk.json']) {
    try { await rename(path, `${path}-backup-${stamp}`) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}
for (const script of ['prepare-seoul.mjs', 'collect-seoul.mjs', 'collect-pharmacies.mjs', 'collect-rent-partitions.mjs', 'collect-boundaries.mjs', 'collect-enrichment.mjs', 'build-seoul-snapshot.ts', 'validate-seoul-snapshot.ts', 'sync-point-enrichment.mjs']) {
  const status = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', `scripts/${script}`], { stdio: 'inherit', env: process.env })
    child.on('exit', code => resolve(code)); child.on('error', () => resolve(1))
  })
  if (status !== 0) { console.error('수집·검증 단계 실패. 캐시와 기존 공개 정상본은 유지됩니다.'); process.exit(1) }
}
