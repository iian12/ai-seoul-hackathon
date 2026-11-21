import { mkdir, writeFile } from 'node:fs/promises'
import { demoSnapshot } from '../src/lib/demo.ts'
import { validateSnapshot } from '../src/lib/recommend.ts'
validateSnapshot(demoSnapshot)
await mkdir('data', { recursive: true })
await writeFile('data/demo-snapshot.json', JSON.stringify(demoSnapshot, null, 2) + '\n')
console.log('가상 값임을 표시한 체험 스냅샷: data/demo-snapshot.json')
