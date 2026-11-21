import {readFile,mkdir,writeFile,rename,readdir} from 'node:fs/promises'
import {gzipSync,gunzipSync} from 'node:zlib'
import {requestJson,decodePage,collectPages} from './enrichment/api.mjs'
const root='data/full-seoul', key=decodeURIComponent(process.env.DATA_GO_KR_SERVICE_KEY||'')
if(!key)throw Error('공공데이터포털 키 필요')
const report=JSON.parse(await readFile(`${root}/report.json`,'utf8'))
for(const [id,path] of [['hira-hospital','B551182/hospInfoServicev2/getHospBasisList'],['hira-pharmacy','B551182/pharmacyInfoService/getParmacyBasisList']]){
 const startedAt=new Date().toISOString(),stage=`${root}/${id}-refresh-${Date.now()}`;await mkdir(stage)
 const query=async(page,size,extra={})=>{const u=new URL('https://apis.data.go.kr/'+path);u.search=new URLSearchParams({serviceKey:key,sidoCd:'110000',numOfRows:String(size),pageNo:String(page),...extra});return decodePage(await requestJson(u,[key]))}
 try{
 let records=[]
 if(id==='hira-pharmacy'){
  const codes=new Set();for(const f of await readdir(`${root}/hira-hospital`)){if(!f.endsWith('.json.gz'))continue;for(const r of JSON.parse(gunzipSync(await readFile(`${root}/hira-hospital/${f}`))).rows)if(r.sgguCd)codes.add(String(r.sgguCd))}
  if(codes.size!==25)throw Error('구 코드 확인 실패')
  for(const code of codes)records.push(...await collectPages((p,n)=>query(p,n,{sgguCd:code}),1000))
  const global=await query(1,1);if(records.length!==global.total)throw Error('약국 전체 건수 불일치')
 }else records=await collectPages(query,1000)
 if(new Set(records.map(r=>r.ykiho)).size!==records.length)throw Error('기관 ID 중복 또는 누락')
 for(let i=0;i<records.length;i+=1000)await writeFile(`${stage}/${String(i/1000+1).padStart(6,'0')}.json.gz`,gzipSync(JSON.stringify({total:records.length,rows:records.slice(i,i+1000)})))
 await rename(`${root}/${id}`,`${root}/${id}-backup-${Date.now()}`);await rename(stage,`${root}/${id}`)
 report.sources[id]={...report.sources[id],status:'complete',expected:records.length,rows:records.length,completedAt:new Date().toISOString(),startedAt}
 console.log(id,records.length,'개 고유 기관 갱신 완료')
 }catch{console.error(id,'갱신 실패 · 기존 검증 캐시 유지');process.exitCode=1}
}
await writeFile(`${root}/report.json`,JSON.stringify(report,null,2))
