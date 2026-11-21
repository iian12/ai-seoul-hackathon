import { mkdir, writeFile, rename, stat, readFile } from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'

await mkdir('data/walking', { recursive: true })
const path = 'data/walking/seoul.osm.pbf'
if (!process.argv.includes('--refresh')) {
  try {
    const source = JSON.parse(await readFile('data/walking/extract-source.json', 'utf8'))
    const info = await stat(path)
    if (source.url && info.size > 1000000) { console.log('저장된 서울 OSM 추출본을 재사용합니다. 새 추출본은 --refresh로 받으세요.'); process.exit(0) }
  } catch { /* initial download */ }
}
const url = 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf'
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok || !response.body) throw new Error('download')
  const hash = createHash('sha256')
  const inspect = new Transform({ transform(chunk, _, callback) { hash.update(chunk); callback(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(`${path}.tmp`))
  if ((await stat(`${path}.tmp`)).size < 1000000) throw new Error('short file')
  await rename(`${path}.tmp`, path)
  await writeFile('data/walking/extract-source.json', JSON.stringify({ url, downloadedAt: new Date().toISOString(), lastModified: response.headers.get('last-modified'), license: 'ODbL 1.0; OpenStreetMap contributors', provider: 'BBBike OSM city extract', sha256: hash.digest('hex') }, null, 2))
  console.log('서울 OSM 도로 추출본과 갱신 시각·SHA256을 저장했습니다.')
} catch { console.error('도로 추출본 다운로드 실패. 기존 도보·추천 스냅샷은 유지합니다.'); process.exitCode = 1 }
