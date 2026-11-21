// 서울 구 이름 다루기(화면용). 구 목록은 src/lib/seoul.ts의 경계 자료에서 읽기만 한다.
import { SEOUL_DISTRICTS } from '../lib/seoul.ts'

/** 서울 25개 구(가나다순) */
export const DISTRICT_NAMES = [...SEOUL_DISTRICTS].sort((a, b) => a.localeCompare(b, 'ko'))

/** "송파", "송파구", "서울시 송파구" → "송파구". 서울 구가 아니면 null */
export function toDistrict(name: string): string | null {
  const n = name.replace(/\s+/g, '').replace(/^서울(특별)?시?/, '')
  if (!n) return null
  const full = n.endsWith('구') ? n : `${n}구`
  return SEOUL_DISTRICTS.has(full) ? full : null
}

export const districtLabel = (ds: string[]) => ds.length <= 3 ? ds.join('·') : `${ds.slice(0, 2).join('·')} 외 ${ds.length - 2}곳`
