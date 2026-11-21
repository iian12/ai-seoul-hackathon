import { readPublishedSnapshot, publishSnapshot } from './publish-snapshot.mjs'
await publishSnapshot(await readPublishedSnapshot())
console.log('추천·시설·보행 자료를 같은 공개 버전으로 검증 완료')
