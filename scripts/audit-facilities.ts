import { readFile, writeFile, readdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { contains, text } from './enrichment/spatial.ts'
const s=JSON.parse(await readFile('public/data/seoul-snapshot.json','utf8'))
const raw=[]
for(const f of await readdir('data/full-seoul/tbSafeReturnItem'))if(f.endsWith('.json.gz'))raw.push(...JSON.parse(gunzipSync(await readFile(`data/full-seoul/tbSafeReturnItem/${f}`)).toString()).rows)
const safety=raw.map(r=>{const p=text(r.POINT_WKT).match(/POINT\s*\(\s*([\d.-]+)\s+([\d.-]+)\s*\)/);return{latitude:Number(p?.[2]),longitude:Number(p?.[1])}})
let extra:any={points:{}}
try{extra=JSON.parse(await readFile('data/enrichment/facilities.json','utf8'))}catch{}
async function hira(id:string){const all=[];for(const f of await readdir(`data/full-seoul/${id}`))if(f.endsWith('.json.gz'))all.push(...JSON.parse(gunzipSync(await readFile(`data/full-seoul/${id}/${f}`)).toString()).rows);return all.filter(r=>id!=='hira-hospital'||!/치과|한방|한의원|요양|정신/.test(text(r.clCdNm))).map(r=>({latitude:Number(r.YPos),longitude:Number(r.XPos)}))}
const lists={safety:[...safety,...extra.points.cctv??[],...extra.points.bell??[]],hospital:extra.points.hospitals??await hira('hira-hospital'),pharmacy:extra.points.pharmacies??await hira('hira-pharmacy')}
const metric={safety:'observedSafety500m',hospital:'hospitals500m',pharmacy:'pharmacies500m'}
const rows=[]
for(const a of s.areas){const coords=(a.boundary.type==='Polygon'?[a.boundary.coordinates]:a.boundary.coordinates).flat(2),xs=coords.map((p:number[])=>p[0]),ys=coords.map((p:number[])=>p[1]);const box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]
 const row:any={code:a.code,district:a.district,name:a.name,facility:{}}
 for(const k of ['safety','hospital','pharmacy'] as const){const inside=lists[k].filter((p:any)=>p.longitude>=box[0]&&p.longitude<=box[2]&&p.latitude>=box[1]&&p.latitude<=box[3]&&contains(a.boundary,p.latitude,p.longitude)).length;const count=a.metrics?.[metric[k]];row.facility[k]={representative500m:count??null,observedInsideBoundary:inside,status:count==null?'missing_metric':count>0?'observed_near_representative':inside>0?'representative_gap':k==='safety'?'unknown_coverage':'no_observations_in_boundary'}}rows.push(row)
}
const report={checkedAt:new Date().toISOString(),snapshotId:s.id,notes:['동 경계 내 관측 시설과 대표점 500m 시설은 서로 다른 지표','안심귀갓길 밖 안전시설 누락은 기존 목록만으로 판별 불가','0건은 실제 시설 부재나 API 결측과 동의어가 아님'],summary:Object.fromEntries(['safety','hospital','pharmacy'].map(k=>[k,Object.fromEntries(['missing_metric','observed_near_representative','representative_gap','unknown_coverage','no_observations_in_boundary'].map(v=>[v,rows.filter(r=>r.facility[k].status===v).length]))])),areas:rows}
const after=process.argv.includes('--after');await writeFile(`data/facility-audit-${after?'after':'before'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary))
