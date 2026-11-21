import { publishSnapshot, readPublishedSnapshot } from './publish-snapshot.mjs'
import { readFile } from 'node:fs/promises'
import { attachCrime, applyPolicingScores } from '../src/lib/crime.ts'
import { validateSnapshot } from '../src/lib/recommend.ts'
const data = JSON.parse(await readFile('src/data/district-crime-2025.json', 'utf8'))
const snapshot = await readPublishedSnapshot()
validateSnapshot(snapshot)
attachCrime(snapshot, data, data.retrievedAt)
applyPolicingScores(snapshot)
snapshot.id = `${snapshot.id.replace(/-crime2025$/, '')}-crime2025`
validateSnapshot(snapshot)
await publishSnapshot(snapshot)
console.log(`자치구 범죄율 ${data.districts.length}개 → ${snapshot.areas.length}개 지역에 기준 구 명시하여 반영`)
