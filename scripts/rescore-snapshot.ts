import { publishSnapshot, readPublishedSnapshot } from './publish-snapshot.mjs'
import { applyPercentileScores } from '../src/lib/score-normalization.ts'
import { validateSnapshot } from '../src/lib/recommend.ts'
import type { Snapshot } from '../src/lib/types.ts'

const snapshot: Snapshot = await readPublishedSnapshot()
validateSnapshot(snapshot)
applyPercentileScores(snapshot)
validateSnapshot(snapshot)
await publishSnapshot(snapshot)
for (const key of ['safety', 'transit', 'medical'] as const) {
  const values = snapshot.areas.map(a => a.scores[key]).filter((v): v is number => v != null)
  const bins = Array.from({ length: 10 }, () => 0)
  for (const value of values) bins[Math.min(9, Math.floor(value / 10))]++
  console.log(key, JSON.stringify({ count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, decileCounts: bins }))
}
