import { publishSnapshot, readPublishedSnapshot } from './publish-snapshot.mjs'
import {applyEnrichment} from './enrichment/apply.ts'
import {applyPercentileScores} from '../src/lib/score-normalization.ts'
import {applyPolicingScores} from '../src/lib/crime.ts'
import {validateSnapshot} from '../src/lib/recommend.ts'
let s=await readPublishedSnapshot()
s.id=`seoul-five-domain-${new Date().toISOString().replace(/[:.]/g,'-')}`;s.createdAt=new Date().toISOString()
s=await applyEnrichment(s);applyPercentileScores(s);applyPolicingScores(s);validateSnapshot(s)
await publishSnapshot(s)
console.log(JSON.stringify({model:s.modelVersion,areas:s.areas.length,reconciliation:s.calculation.enrichmentQa.medicalReconciliation}))
