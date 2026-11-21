import { distance, text } from './spatial.ts'
const name = (v: unknown) => text(v).replace(/[^가-힣a-zA-Z0-9]/g, '').toLowerCase()
const phone = (v: unknown) => text(v).replace(/\D/g, '')
export function reconcileMedical(hira: Record<string, unknown>[], nmc: Record<string, unknown>[]) {
  const byKey = new Map<string, Record<string, unknown>[]>()
  for (const r of nmc) { const p = phone(r.dutyTel1); if (p.length < 8) continue; const k = `${name(r.dutyName)}:${p}`; byKey.set(k, [...byKey.get(k) ?? [], r]) }
  const qa = { sourceRows: hira.length, uniqueMatches: 0, repairedCoordinates: 0, movedCoordinates: 0, ambiguous: 0, rejectedAddress: 0 }
  const points = hira.map(r => {
    let latitude = Number(r.YPos), longitude = Number(r.XPos)
    const candidates = byKey.get(`${name(r.yadmNm)}:${phone(r.telno)}`) ?? []
    if (candidates.length > 1) qa.ambiguous++
    if (candidates.length === 1) {
      const n = candidates[0], addr = text(r.addr).split(/\s+/), naddr = text(n.dutyAddr)
      const sameDistrict = addr[1]?.endsWith('구') && naddr.includes(addr[1])
      const lat = Number(n.wgs84Lat), lon = Number(n.wgs84Lon)
      const validOld = latitude > 37 && latitude < 38 && longitude > 126 && longitude < 128
      if (sameDistrict && lat > 37 && lat < 38 && lon > 126 && lon < 128 && (!validOld || distance({ latitude, longitude }, { latitude: lat, longitude: lon }) <= 100)) {
        qa.uniqueMatches++; if (!validOld) qa.repairedCoordinates++; else if (Math.abs(latitude-lat)+Math.abs(longitude-lon)>1e-7) qa.movedCoordinates++
        latitude = lat; longitude = lon
      } else qa.rejectedAddress++
    }
    return { id: text(r.ykiho), latitude, longitude }
  })
  return { points, qa }
}
