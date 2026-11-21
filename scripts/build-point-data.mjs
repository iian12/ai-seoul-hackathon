// 지도에서 찍은 위치 점검용 데이터 만들기 (Node만 있으면 됨 · Windows·macOS·Linux 공통, 추가 패키지 없음)
//
//   node scripts/build-point-data.mjs
//
// 입력(기존 파일은 읽기만 함)
//   data/walking/seoul.osm.pbf        OSM 보행 도로망·지하철 출입구 (BBBike 서울 추출본)
//   data/full-seoul/<원천>/*.json.gz   안심귀갓길 시설·버스정류장·병의원·약국·응급실·지하철역
//   public/data/seoul-snapshot.json    점수 정규화 기준(서울 전체 동의 백분위)
//   src/data/seoul-districts.json      서울 경계
// 출력(새 파일)
//   public/data/point-facilities.json  시설 좌표 + 정규화 기준 + 격자 정보
//   public/data/point-walk.bin         50m 격자마다 '가장 가까운 지하철 출입구까지 보행 도로망 최단거리(m)'와 역 번호
//
// 보행 거리 규칙은 scripts/walking_graph.py·build-walking.py(동 대표점 경로 계산)와 같다:
//   걸을 수 있는 길만 연결, 출입구까지 다익스트라 최단거리, 시작점은 100m 안 보행로에 붙임(붙인 거리는 합산하지 않음),
//   출입구가 길에서 떨어져 있으면 20m 안에서만 연결. 직선거리 보정값을 쓰지 않는다.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = process.cwd()
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// ───────────────────────── 1. OSM PBF 읽기 (protobuf 최소 해석기) ─────────────────────────
class Reader {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end }
  varint() {
    let r = 0, mul = 1, byte
    do { byte = this.b[this.p++]; r += (byte & 0x7f) * mul; mul *= 128 } while (byte & 0x80)
    return r
  }
  sint() { const n = this.varint(); return n % 2 === 0 ? n / 2 : -(n + 1) / 2 }
  bytes() { const len = this.varint(); const s = this.p; this.p += len; return [s, this.p] }
  skip(wire) { if (wire === 0) this.varint(); else if (wire === 1) this.p += 8; else if (wire === 2) { const len = this.varint(); this.p += len } else if (wire === 5) this.p += 4; else throw new Error(`wire ${wire}`) }
  packed(fn) { const [s, e] = this.bytes(); const out = []; const r = new Reader(this.b, s, e); while (r.p < e) out.push(fn(r)); return out }
}
const packedVarint = r => r.packed(x => x.varint())
const packedSint = r => r.packed(x => x.sint())

function* blocks(buf) {
  let p = 0
  while (p < buf.length) {
    const hlen = buf.readUInt32BE(p); p += 4
    const h = new Reader(buf, p, p + hlen); let type = '', size = 0
    while (h.p < h.end) { const key = h.varint(), f = key >> 3, w = key & 7; if (f === 1) { const [s, e] = h.bytes(); type = buf.toString('utf8', s, e) } else if (f === 3) size = h.varint(); else h.skip(w) }
    p += hlen
    const b = new Reader(buf, p, p + size); let raw = null, zlib = null
    while (b.p < b.end) { const key = b.varint(), f = key >> 3, w = key & 7; if (f === 1) { const [s, e] = b.bytes(); raw = buf.subarray(s, e) } else if (f === 3) { const [s, e] = b.bytes(); zlib = buf.subarray(s, e) } else b.skip(w) }
    p += size
    if (type !== 'OSMData') continue
    if (!raw && !zlib) throw new Error('지원하지 않는 PBF 압축 형식입니다(zlib·raw만 지원).')
    yield raw ?? inflateSync(zlib)
  }
}

/** PrimitiveBlock 하나를 풀어 노드·길을 콜백으로 넘긴다. */
function readBlock(data, onNode, onWay) {
  const r = new Reader(data); const strings = []; const groups = []; let gran = 100, latOff = 0, lonOff = 0
  while (r.p < r.end) {
    const key = r.varint(), f = key >> 3, w = key & 7
    if (f === 1) { const [s, e] = r.bytes(); const st = new Reader(data, s, e); while (st.p < st.end) { const k = st.varint(); if (k >> 3 === 1) { const [a, b] = st.bytes(); strings.push(data.toString('utf8', a, b)) } else st.skip(k & 7) } }
    else if (f === 2) groups.push(r.bytes())
    else if (f === 17) gran = r.varint(); else if (f === 19) latOff = r.sint(); else if (f === 20) lonOff = r.sint(); else r.skip(w)
  }
  const coord = (v, off) => (off + gran * v) * 1e-9
  for (const [gs, ge] of groups) {
    const g = new Reader(data, gs, ge)
    while (g.p < g.end) {
      const key = g.varint(), f = key >> 3, w = key & 7
      if (f === 2 && onNode) { // DenseNodes
        const [s, e] = g.bytes(); const d = new Reader(data, s, e); let ids = [], lats = [], lons = [], kv = []
        while (d.p < d.end) { const k = d.varint(), ff = k >> 3, ww = k & 7; if (ff === 1) ids = packedSint(d); else if (ff === 8) lats = packedSint(d); else if (ff === 9) lons = packedSint(d); else if (ff === 10) kv = packedVarint(d); else d.skip(ww) }
        let id = 0, lat = 0, lon = 0, j = 0
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; lat += lats[i]; lon += lons[i]
          let tags = null
          if (kv.length) { while (j < kv.length && kv[j] !== 0) { (tags ??= {})[strings[kv[j]]] = strings[kv[j + 1]]; j += 2 } j++ }
          onNode(id, coord(lat, latOff), coord(lon, lonOff), tags)
        }
      } else if (f === 1 && onNode) { // 단일 Node
        const [s, e] = g.bytes(); const d = new Reader(data, s, e); let id = 0, lat = 0, lon = 0, keys = [], vals = []
        while (d.p < d.end) { const k = d.varint(), ff = k >> 3, ww = k & 7; if (ff === 1) id = d.sint(); else if (ff === 2) keys = packedVarint(d); else if (ff === 3) vals = packedVarint(d); else if (ff === 8) lat = d.sint(); else if (ff === 9) lon = d.sint(); else d.skip(ww) }
        const tags = keys.length ? Object.fromEntries(keys.map((k, i) => [strings[k], strings[vals[i]]])) : null
        onNode(id, coord(lat, latOff), coord(lon, lonOff), tags)
      } else if (f === 3 && onWay) { // Way
        const [s, e] = g.bytes(); const d = new Reader(data, s, e); let keys = [], vals = [], refs = []
        while (d.p < d.end) { const k = d.varint(), ff = k >> 3, ww = k & 7; if (ff === 2) keys = packedVarint(d); else if (ff === 3) vals = packedVarint(d); else if (ff === 8) refs = packedSint(d); else d.skip(ww) }
        const tags = {}; keys.forEach((k, i) => { tags[strings[k]] = strings[vals[i]] })
        let id = 0; onWay(tags, refs.map(x => (id += x)))
      } else g.skip(w)
    }
  }
}

// ───────────────────────── 2. 보행 규칙 (walking_graph.py와 같음) ─────────────────────────
const SPEED = 4.5 / 3.6, MAX_SNAP = 100, ENTRANCE_SNAP = 20
const FORBIDDEN = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed', 'raceway'])
const ALLOW_FOOT = new Set(['yes', 'designated', 'permissive', 'official'])
function walkable(t) {
  const h = t.highway ?? ''
  if (!h || FORBIDDEN.has(h) || t.area === 'yes') return false
  if (['no', 'private', 'use_sidepath'].includes(t.foot)) return false
  if (['no', 'private', 'customers', 'delivery', 'permit'].includes(t.access) && !ALLOW_FOOT.has(t.foot)) return false
  if (t['foot:conditional'] || t['access:conditional']) return false
  if ((h === 'cycleway' || h === 'bridleway') && !ALLOW_FOOT.has(t.foot)) return false
  return true
}
const publicEntrance = t => t.railway === 'subway_entrance' && !['no', 'private', 'customers'].includes(t.access) && !['no', 'private'].includes(t.foot) && t.entrance !== 'exit'
const blockedNode = t => ['no', 'private'].includes(t.access) || ['no', 'private'].includes(t.foot) || ['fence', 'wall', 'block'].includes(t.barrier)
const inBox = (lon, lat) => lon > 126.70 && lon < 127.25 && lat > 37.38 && lat < 37.76
function distance(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180, a1 = lat1 * r, a2 = lat2 * r, dy = a2 - a1, dx = (lon2 - lon1) * r
  const h = Math.sin(dy / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dx / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

// 서울 경계(점이 서울 안인지)
const districts = JSON.parse(readFileSync(join(ROOT, 'src/data/seoul-districts.json'), 'utf8'))
const seoulPolys = districts.features.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
  .map(p => { const xs = p[0].map(v => v[0]), ys = p[0].map(v => v[1]); return { p, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } })
function inRing(x, y, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside } return inside }
const inSeoul = (x, y) => seoulPolys.some(({ p, x0, x1, y0, y1 }) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h)))

const pbfPath = join(ROOT, 'data/walking/seoul.osm.pbf')
if (!existsSync(pbfPath)) throw new Error('data/walking/seoul.osm.pbf가 없습니다. npm run walking:download로 먼저 받아 주세요.')
const pbf = readFileSync(pbfPath)

// 1차: 걸을 수 있는 길과 필요한 노드, 막힌 노드·출입구
log('PBF 1차 읽기(길·태그)')
const ways = []; const needed = new Set(); const blocked = new Set(); const entrancesRaw = new Map()
for (const data of blocks(pbf)) readBlock(data, (id, lat, lon, tags) => {
  if (!tags) return
  if (blockedNode(tags)) blocked.add(id)
  if (publicEntrance(tags)) entrancesRaw.set(id, { lat, lon, name: tags.name ?? '' })
}, (tags, refs) => {
  if (!walkable(tags) || refs.length < 2) return
  const dir = tags['oneway:foot'] === 'yes' ? 1 : tags['oneway:foot'] === '-1' ? -1 : 0
  ways.push({ refs, dir, speed: tags.highway === 'steps' ? 0.8 : SPEED })
  for (const r of refs) needed.add(r)
})
log(`걸을 수 있는 길 ${ways.length.toLocaleString()}개, 필요한 노드 ${needed.size.toLocaleString()}개, 출입구 ${entrancesRaw.size}개`)

// 2차: 필요한 노드 좌표
const nodeIndex = new Map(); const lonArr = [], latArr = []
for (const data of blocks(pbf)) readBlock(data, (id, lat, lon) => { if (needed.has(id) && !nodeIndex.has(id)) { nodeIndex.set(id, lonArr.length); lonArr.push(lon); latArr.push(lat) } }, null)
needed.clear()
log(`좌표 확보 노드 ${nodeIndex.size.toLocaleString()}개`)

// 간선 만들기
const eu = [], ev = [], elen = [], edir = [], espd = []
const used = new Uint8Array(lonArr.length)
for (const w of ways) for (let i = 0; i + 1 < w.refs.length; i++) {
  const a = w.refs[i], b = w.refs[i + 1]
  const ia = nodeIndex.get(a), ib = nodeIndex.get(b)
  if (ia == null || ib == null || blocked.has(a) || blocked.has(b)) continue
  if (!inBox(lonArr[ia], latArr[ia]) || !inBox(lonArr[ib], latArr[ib])) continue
  const len = distance(lonArr[ia], latArr[ia], lonArr[ib], latArr[ib])
  if (len <= 0.01) continue
  eu.push(ia); ev.push(ib); elen.push(len); edir.push(w.dir); espd.push(w.speed); used[ia] = used[ib] = 1
}
ways.length = 0
log(`보행 간선 ${eu.length.toLocaleString()}개`)

// 간선 공간 색인(0.002도 칸)
const CELL = 0.002, cells = new Map()
const cellKey = (x, y) => x * 100000 + y
for (let i = 0; i < eu.length; i++) {
  const ax = lonArr[eu[i]], ay = latArr[eu[i]], bx = lonArr[ev[i]], by = latArr[ev[i]]
  for (let x = Math.floor(Math.min(ax, bx) / CELL); x <= Math.floor(Math.max(ax, bx) / CELL); x++)
    for (let y = Math.floor(Math.min(ay, by) / CELL); y <= Math.floor(Math.max(ay, by) / CELL); y++) {
      const k = cellKey(x, y); let list = cells.get(k); if (!list) cells.set(k, list = []); list.push(i)
    }
}
function snap(lon, lat, max) {
  const x = Math.floor(lon / CELL), y = Math.floor(lat / CELL); let best = null
  const kx = Math.cos(lat * Math.PI / 180) * 111195, ky = 111195
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of cells.get(cellKey(x + dx, y + dy)) ?? []) {
    const ax = (lonArr[eu[i]] - lon) * kx, ay = (latArr[eu[i]] - lat) * ky, bx = (lonArr[ev[i]] - lon) * kx, by = (latArr[ev[i]] - lat) * ky
    const ddx = bx - ax, ddy = by - ay, L = ddx * ddx + ddy * ddy
    const t = L ? Math.max(0, Math.min(1, -(ax * ddx + ay * ddy) / L)) : 0
    const sx = lonArr[eu[i]] + t * (lonArr[ev[i]] - lonArr[eu[i]]), sy = latArr[eu[i]] + t * (latArr[ev[i]] - latArr[eu[i]])
    const off = distance(lon, lat, sx, sy)
    if (!best || off < best.off) best = { off, i, sx, sy }
  }
  return best && best.off <= max ? best : null
}

// 역 이름(지하철역 마스터)
function rows(name) {
  const dir = join(ROOT, 'data/full-seoul', name)
  if (!existsSync(dir)) throw new Error(`data/full-seoul/${name}이 없습니다.`)
  return readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort().flatMap(f => { const d = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8')); return Array.isArray(d) ? d : d.rows ?? [] })
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN }
const stationRows = rows('subwayStationMaster').map(r => ({ name: String(r.BLDN_NM ?? '').replace(/\(.*\)$/, '').trim(), lat: num(r.LAT), lon: num(r.LOT), line: String(r.ROUTE ?? '') })).filter(s => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon))
const stationNames = [...new Set(stationRows.map(s => s.name))]
const stationOf = (lon, lat) => { let best = -1, bd = Infinity; for (const s of stationRows) { const d = distance(lon, lat, s.lon, s.lat); if (d < bd) { bd = d; best = stationNames.indexOf(s.name) } } return bd <= 700 ? best : -1 }

// 출입구 연결(직접 또는 20m 안 보행로) — 역방향 인접 목록
const N0 = lonArr.length
const extra = [] // [virtualIndex] → { from: [[node, metres]] }
const sources = [] // { node, station }
for (const [id, e] of entrancesRaw) {
  if (!inSeoul(e.lon, e.lat)) continue
  const idx = nodeIndex.get(id)
  if (idx != null && used[idx]) { sources.push({ node: idx, station: stationOf(e.lon, e.lat) }); continue }
  const s = snap(e.lon, e.lat, ENTRANCE_SNAP); if (!s) continue
  const v = N0 + extra.length; const from = []
  const u = eu[s.i], w = ev[s.i], len = elen[s.i], dir = edir[s.i]
  if (dir === 0 || dir === 1) from.push([u, Math.min(len, distance(lonArr[u], latArr[u], s.sx, s.sy)), espd[s.i]])
  if (dir === 0 || dir === -1) from.push([w, Math.min(len, distance(lonArr[w], latArr[w], s.sx, s.sy)), espd[s.i]])
  extra.push({ from }); sources.push({ node: v, station: stationOf(e.lon, e.lat) })
}
const N = N0 + extra.length
log(`연결된 출입구 ${sources.length}개`)

// CSR 역방향 그래프: rev[node] = 그 노드로 걸어 들어올 수 있는 이전 노드들
const deg = new Uint32Array(N + 1)
for (let i = 0; i < eu.length; i++) { if (edir[i] === 0 || edir[i] === 1) deg[ev[i]]++; if (edir[i] === 0 || edir[i] === -1) deg[eu[i]]++ }
extra.forEach((x, k) => { deg[N0 + k] += x.from.length })
const start = new Uint32Array(N + 1); for (let i = 0; i < N; i++) start[i + 1] = start[i] + deg[i]
const fill = start.slice(0, N), prev = new Uint32Array(start[N]), cost = new Float32Array(start[N]), secs = new Float32Array(start[N])
for (let i = 0; i < eu.length; i++) {
  if (edir[i] === 0 || edir[i] === 1) { const k = fill[ev[i]]++; prev[k] = eu[i]; cost[k] = elen[i]; secs[k] = elen[i] / espd[i] }
  if (edir[i] === 0 || edir[i] === -1) { const k = fill[eu[i]]++; prev[k] = ev[i]; cost[k] = elen[i]; secs[k] = elen[i] / espd[i] }
}
extra.forEach((x, k) => { for (const [u, m, sp] of x.from) { const j = fill[N0 + k]++; prev[j] = u; cost[j] = m; secs[j] = m / sp } })

// 여러 출발점 다익스트라(출입구 → 역방향) : 모든 노드에서 가장 가까운 출입구까지의 보행 최단거리
const dist = new Float64Array(N).fill(Infinity), time = new Float64Array(N), owner = new Int32Array(N).fill(-1)
const heapN = [], heapD = []
const push = (n, d) => { heapN.push(n); heapD.push(d); let i = heapN.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heapD[p] <= heapD[i]) break;[heapN[p], heapN[i]] = [heapN[i], heapN[p]];[heapD[p], heapD[i]] = [heapD[i], heapD[p]]; i = p } }
const pop = () => { const n = heapN[0], d = heapD[0], ln = heapN.pop(), ld = heapD.pop(); if (heapN.length) { heapN[0] = ln; heapD[0] = ld; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heapN.length && heapD[l] < heapD[m]) m = l; if (r < heapN.length && heapD[r] < heapD[m]) m = r; if (m === i) break;[heapN[m], heapN[i]] = [heapN[i], heapN[m]];[heapD[m], heapD[i]] = [heapD[i], heapD[m]]; i = m } } return [n, d] }
for (const s of sources) { if (dist[s.node] > 0) { dist[s.node] = 0; owner[s.node] = s.station; push(s.node, 0) } }
while (heapN.length) {
  const [n, d] = pop(); if (d !== dist[n]) continue
  for (let k = start[n]; k < start[n + 1]; k++) { const p = prev[k], nd = d + cost[k]; if (nd < dist[p]) { dist[p] = nd; time[p] = time[n] + secs[k]; owner[p] = owner[n]; push(p, nd) } }
}
log('보행 최단거리 계산 완료')

/** 한 점에서 가장 가까운 출입구까지 보행 거리(시작점 보정 거리는 합산하지 않음) */
function walkFrom(lon, lat) {
  const s = snap(lon, lat, MAX_SNAP); if (!s) return null
  const u = eu[s.i], v = ev[s.i], len = elen[s.i], dir = edir[s.i]; let best = null
  for (const [node, ok] of [[u, dir === 0 || dir === -1], [v, dir === 0 || dir === 1]]) {
    if (!ok || !Number.isFinite(dist[node])) continue
    const part = Math.min(len, distance(s.sx, s.sy, lonArr[node], latArr[node])), m = part + dist[node]
    if (!best || m < best.m) best = { m, sec: part / espd[s.i] + time[node], st: owner[node] }
  }
  return best
}

// ───────────────────────── 3. 50m 격자 ─────────────────────────
const STEP_M = 50
const LAT0 = 37.413, LAT1 = 37.716, LON0 = 126.734, LON1 = 127.27
const dLat = STEP_M / 111195, dLon = STEP_M / (111195 * Math.cos(37.565 * Math.PI / 180))
const rowsN = Math.ceil((LAT1 - LAT0) / dLat), colsN = Math.ceil((LON1 - LON0) / dLon)
const walkM = new Uint16Array(rowsN * colsN).fill(0xffff), walkS = new Uint16Array(rowsN * colsN).fill(0xffff), walkSt = new Uint16Array(rowsN * colsN).fill(0xffff)
let filled = 0, inside = 0
for (let r = 0; r < rowsN; r++) for (let c = 0; c < colsN; c++) {
  const lat = LAT0 + (r + 0.5) * dLat, lon = LON0 + (c + 0.5) * dLon
  if (!inSeoul(lon, lat)) continue
  inside++
  const w = walkFrom(lon, lat); if (!w) continue
  walkM[r * colsN + c] = Math.min(0xfffe, Math.round(w.m)); walkS[r * colsN + c] = Math.min(0xfffe, Math.round(w.sec)); walkSt[r * colsN + c] = w.st >= 0 ? w.st : 0xffff; filled++
}
log(`격자 ${colsN}×${rowsN}, 서울 안 ${inside.toLocaleString()}칸 중 경로 확인 ${filled.toLocaleString()}칸`)
writeFileSync(join(ROOT, 'public/data/point-walk.bin'), Buffer.concat([Buffer.from(walkM.buffer), Buffer.from(walkS.buffer), Buffer.from(walkSt.buffer)]))

// 검증: 동 대표점에서 이 계산과 기존 경로(build-walking.py 결과)를 비교
const snapshot = JSON.parse(readFileSync(join(ROOT, 'public/data/seoul-snapshot.json'), 'utf8'))
const diffs = []
const secDiffs = []
for (const a of snapshot.areas) if (a.walking?.status === 'ok') { const w = walkFrom(a.longitude, a.latitude); if (w) { diffs.push(Math.abs(w.m - a.walking.distanceM)); secDiffs.push(Math.abs(w.sec - a.walking.durationSeconds)) } }
secDiffs.sort((x, y) => x - y)
diffs.sort((x, y) => x - y)
const q = p => diffs[Math.floor((diffs.length - 1) * p)]
const check = { compared: diffs.length, medianAbsDiffM: Math.round(q(.5)), p90AbsDiffM: Math.round(q(.9)), within20m: diffs.filter(d => d <= 20).length, maxAbsDiffM: Math.round(diffs[diffs.length - 1]), medianAbsDiffSec: Math.round(secDiffs[Math.floor(secDiffs.length / 2)]), maxAbsDiffSec: Math.round(secDiffs[secDiffs.length - 1]) }
log('기존 동 대표점 경로와 비교', check)

// ───────────────────────── 4. 시설 좌표 (build-seoul-snapshot.ts와 같은 걸러내기) ─────────────────────────
const enc = (lat, lon) => [Math.round(lat * 1e5), Math.round(lon * 1e5)]
/** 좌표가 맞고 서울 안이며 같은 id가 처음 나온 것만(build-seoul-snapshot.ts의 points()와 같은 규칙) */
const pts = (list, idKey) => { const seen = new Set(); return list.filter(([lat, lon, id]) => { if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inSeoul(lon, lat)) return false; if (seen.has(id)) return false; seen.add(id); return true }).flatMap(([lat, lon]) => enc(lat, lon)) }
const id = v => String(v ?? '')
const bus = pts(rows('busStopLocationXyInfo').filter(r => !/선착장/.test(String(r.STOPS_TYPE ?? ''))).map(r => [num(r.YCRD), num(r.XCRD), id(r.STOPS_NO)]))
const safetyRows = rows('tbSafeReturnItem').map(r => { const m = String(r.POINT_WKT ?? '').match(/POINT\s*\(\s*([\d.-]+)\s+([\d.-]+)\s*\)/); return [Number(m?.[2]), Number(m?.[1]), id(r.FACI_ID), String(r.FACI_CODE ?? '')] })
const safety = pts(safetyRows)
// CCTV는 전체 안전시설에서 중복을 걸러낸 뒤 302만 고른다(스냅샷과 같은 순서)
const cctv = (() => { const seen = new Set(); return safetyRows.filter(([lat, lon, fid]) => { if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inSeoul(lon, lat) || seen.has(fid)) return false; seen.add(fid); return true }).filter(r => r[3] === '302').flatMap(([lat, lon]) => enc(lat, lon)) })()
const hospitals = pts(rows('hira-hospital').filter(r => !/치과|한방|한의원|요양|정신/.test(String(r.clCdNm ?? ''))).map(r => [num(r.YPos), num(r.XPos), id(r.ykiho)]))
const pharmacies = pts(rows('hira-pharmacy').map(r => [num(r.YPos), num(r.XPos), id(r.ykiho)]))
const emergency = pts(rows('nmc-emergency').filter(r => String(r.dutyEmcls) !== 'G099').map(r => [num(r.wgs84Lat), num(r.wgs84Lon), id(r.hpid)]))
const night = pts(rows('nmc-pharmacy').filter(r => Array.from({ length: 8 }, (_, i) => String(r[`dutyTime${i + 1}c`] ?? '')).some(s => /^\d{4}$/.test(s) && (Number(s) >= 2200 || Number(s) <= 600))).map(r => [num(r.wgs84Lat), num(r.wgs84Lon), id(r.hpid)]))

// 정규화 기준: 스냅샷이 동 점수를 만들 때 쓴 백분위 기준을 그대로 쓴다(교통은 보행 경로가 확인된 동 기준)
const calc = snapshot.calculation ?? {}
if (!calc.normalization || !calc.transitNormalization) throw new Error('스냅샷에 정규화 기준이 없습니다. 보행 경로가 붙은 스냅샷이 필요합니다.')
const normalization = { safety: calc.normalization.safety, transit: calc.transitNormalization, medical: calc.normalization.medical }

const out = {
  version: 1,
  createdAt: new Date().toISOString(),
  snapshotId: snapshot.id,
  note: '좌표는 위도·경도에 100000을 곱한 정수를 [위도, 경도, 위도, 경도, …] 순서로 담았다.',
  normalization,
  formulas: {
    safety: '0.5 × min(500m 안 CCTV 수 / 5, 1) + 0.5 × exp(−가장 가까운 안심귀갓길 시설 거리 / 500)',
    transit: '0.6 × exp(−가장 가까운 지하철 출입구까지 보행 거리 / 500) + 0.4 × exp(−가장 가까운 버스정류장 직선거리 / 300)',
    medical: '0.5 × exp(−병·의원 거리 / 500) + 0.3 × exp(−약국 거리 / 500) + 0.2 × exp(−응급기관 거리 / 3000)',
  },
  walkGrid: { file: 'point-walk.bin', stepM: STEP_M, lat0: LAT0, lon0: LON0, dLat, dLon, rows: rowsN, cols: colsN, encoding: 'Uint16 리틀엔디언 세 덩어리(각 rows×cols, 행은 남→북·열은 서→동): 보행거리(m), 걷는 시간(초, 일반 길 4.5km/h·계단 0.8m/s), 가까운 출입구의 역 번호(stations). 65535 = 경로 없음', check },
  stations: stationNames,
  // 역 이름 검색용 위치(같은 이름의 여러 노선 좌표 평균), stations와 같은 순서
  stationPoints: stationNames.flatMap(n => { const l = stationRows.filter(r => r.name === n); return enc(l.reduce((t, r) => t + r.lat, 0) / l.length, l.reduce((t, r) => t + r.lon, 0) / l.length) }),
  stationLines: stationNames.map(n => [...new Set(stationRows.filter(r => r.name === n).map(r => r.line).filter(Boolean))].join(' · ')),
  points: { bus, safety, cctv, hospitals, pharmacies, emergency, night },
  sources: ['OpenStreetMap contributors / BBBike (ODbL) 보행 도로망·지하철 출입구', '서울시 안심귀갓길 안전시설물(2022 조사)', '서울시 버스정류소 위치', '건강보험심사평가원 병원·약국 정보', '국립중앙의료원 응급의료기관·약국 운영시간', '서울시 역사마스터'],
}
writeFileSync(join(ROOT, 'public/data/point-facilities.json'), JSON.stringify(out))
log('완료', { bus: bus.length / 2, safety: safety.length / 2, cctv: cctv.length / 2, hospitals: hospitals.length / 2, pharmacies: pharmacies.length / 2, emergency: emergency.length / 2, night: night.length / 2, stations: stationNames.length })
