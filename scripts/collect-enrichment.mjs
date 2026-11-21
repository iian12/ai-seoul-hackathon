// Full pages only; no sample data is published as a complete source.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { requestJson, decodePage, collectPages, SourceError } from './enrichment/api.mjs'

const root = 'data/enrichment'
await mkdir(root, { recursive: true })
const definitions = [
  { id: 'cctv', name: '서울 지역 공공 CCTV', env: 'DATA_GO_KR_SERVICE_KEY', url: 'https://apis.data.go.kr/1741000/cctv_info/info', params: { returnType: 'json', 'cond[LCTN_ROAD_NM_ADDR::LIKE]': '서울특별시' }, catalog: 'https://www.data.go.kr/data/15155042/openapi.do', license: '이용허락범위 제한 없음' },
  { id: 'bell', name: '서울 지역 안전비상벨', env: 'DATA_GO_KR_SERVICE_KEY', url: 'https://apis.data.go.kr/1741000/emergency_call_box_info/info', params: { returnType: 'json', 'cond[LCTN_ROAD_NM_ADDR::LIKE]': '서울특별시' }, catalog: 'https://www.data.go.kr/data/15155046/openapi.do', license: '이용허락범위 제한 없음' },
  { id: 'stores', name: '서울 생활편의 업소', env: 'DATA_GO_KR_SERVICE_KEY', url: 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong', params: { divId: 'ctprvnCd', key: '11', type: 'json' }, catalog: 'https://www.data.go.kr/data/15012005/openapi.do', license: '이용허락범위 제한 없음' },
  { id: 'flood', name: '침수흔적도', env: 'SAFETYDATA_API_KEY', url: 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00117', params: { returnType: 'json' }, catalog: 'https://www.safetydata.go.kr/disaster-data/view?dataSn=108', license: '제공처 이용조건 확인 필요 (포털과 공유플랫폼 표시 상이)' },
  { id: 'pharmacy-hours', name: '약국 공시 운영시간', env: 'DATA_GO_KR_SERVICE_KEY', url: 'https://apis.data.go.kr/B552657/ErmctInsttInfoInqireService/getParmacyListInfoInqire', params: { Q0: '서울특별시' }, catalog: 'https://www.data.go.kr/data/15000576/openapi.do', license: '이용허락범위 제한 없음' },
  { id: 'hospital-hours', name: '병·의원 공시 운영시간', env: 'DATA_GO_KR_SERVICE_KEY', url: 'https://apis.data.go.kr/B552657/HsptlAsembySearchService/getHsptlMdcncListInfoInqire', params: { Q0: '서울특별시' }, catalog: 'https://www.data.go.kr/data/15000736/openapi.do', license: '이용허락범위 제한 없음' },
]
const states = []
for (const def of definitions) {
  const state = { id: def.id, name: def.name, checkedAt: new Date().toISOString(), status: 'missing_key', catalog: def.catalog, license: def.license }
  try {
    const key = decodeURIComponent(process.env[def.env] || '')
    if (!key) { state.message = `${def.env} 설정 필요`; states.push(state); continue }
    const records = await collectPages(async (page, size) => {
      const url = new URL(def.url)
      url.search = new URLSearchParams({ serviceKey: key, pageNo: String(page), numOfRows: String(size), ...def.params })
      return decodePage(await requestJson(url, [key]))
    }, def.id.endsWith('-hours') ? 1000 : 100)
    if (!records.length) throw new SourceError('failed', 'empty_source')
    const file = `${def.id}-${Date.now()}.json.gz`
    await writeFile(`${root}/${file}.tmp`, gzipSync(JSON.stringify(records)))
    await rename(`${root}/${file}.tmp`, `${root}/${file}`)
    Object.assign(state, { status: 'complete', rows: records.length, file, retrievedAt: new Date().toISOString() })
  } catch (error) { state.status = error instanceof SourceError ? error.status : 'failed'; state.message = error instanceof SourceError ? error.message : 'collection_failed' }
  states.push(state)
  console.log(`${state.id}: ${state.status}${state.rows ? ` (${state.rows})` : ''}`)
}
// VWorld and ODsay use their own keys, not the data.go.kr key.
let boundary
try { boundary = JSON.parse(await readFile(`${root}/boundary-status.json`, 'utf8')) } catch { /* no boundary collector run */ }
states.push(boundary ?? { id: 'boundary', name: '공식 법정동 경계', status: 'missing_key', checkedAt: new Date().toISOString(), message: 'VWORLD_API_KEY 설정 및 npm run data:boundary 필요' })
await writeFile(`${root}/manifest.tmp`, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sources: states }, null, 2))
await rename(`${root}/manifest.tmp`, `${root}/manifest.json`)
console.log('보완 수집 상태 저장 완료. 실패 원천은 기존 자료와 구분합니다.')
