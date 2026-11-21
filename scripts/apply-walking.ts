import { publishSnapshot, readPublishedSnapshot } from './publish-snapshot.mjs'
import { readFile } from 'node:fs/promises'
import { attachWalking } from '../src/lib/walking-snapshot.ts'
import { validateSnapshot } from '../src/lib/recommend.ts'
const snapshot = await readPublishedSnapshot()
const data = JSON.parse(await readFile('data/walking/routes.json', 'utf8'))
const next = attachWalking(snapshot, data)
validateSnapshot(next)
await publishSnapshot(next)
console.log(JSON.stringify({ model: next.modelVersion, regions: next.areas.length, confirmed: next.areas.filter(a => a.walking?.status === 'ok').length, report: data.report.statuses }, null, 2))
