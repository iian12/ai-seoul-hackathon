import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
// Fixed official 2025 editions. A changed edition requires reviewing its year and schema.
const reference = JSON.parse(await readFile('src/data/district-crime-2025.json', 'utf8'))
const population = new URL('https://data.seoul.go.kr/together/statbook/fileDownload.do')
population.search = new URLSearchParams({ cotCd: '052', filename: '202601200937337273', mnuFg: 'C', mnuSrl: '2630', upMnuSrl: '2457', mnuNm: '2025년 4분기 등록인구통계' })
await mkdir('data/crime', { recursive: true })
for (const [name, url] of [['crime.csv', 'https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000007729840&fileDetailSn=1&insertDataPrcus=N'], ['population-2025.xlsx', population]]) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`공식 범죄율 원천 수집 실패: ${r.status}`)
  const bytes = Buffer.from(await r.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== reference.hashes[name]) throw new Error('공식 파일 변경 감지: 기준연도·열 정의를 재검증해야 합니다.')
  await writeFile(`data/crime/${name}.tmp`, bytes)
  await rename(`data/crime/${name}.tmp`, `data/crime/${name}`)
}
console.log('2025년 범죄·인구 공식 원본 무결성 확인 완료')
