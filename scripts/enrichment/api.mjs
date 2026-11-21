import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'

export class SourceError extends Error {
  constructor(status, reason) { super(reason); this.status = status }
}
export async function requestJson(url, secrets = [], fetcher = fetch) {
  let response
  try { response = await fetcher(url, { signal: AbortSignal.timeout(25000), redirect: 'error' }) } catch { throw new SourceError('failed', 'network_error') }
  const text = await response.text()
  if (secrets.filter(Boolean).some(k => text.includes(k) || text.includes(encodeURIComponent(k)))) throw new SourceError('failed', 'secret_echo')
  if ([401, 403].includes(response.status) || /SERVICE_KEY_IS_NOT_REGISTERED|UNREGISTERED_KEY|INVALID_KEY|AUTHENTICATION_FAILED/.test(text)) throw new SourceError('unauthorized', 'service_not_authorized')
  if (!response.ok) throw new SourceError('failed', `http_${response.status}`)
  let json
  try { json = JSON.parse(text) } catch {
    if (!text.trim().startsWith('<')) throw new SourceError('failed', 'invalid_json')
    json = new XMLParser({ parseTagValue: false }).parse(text)
  }
  return json
}

export function decodePage(json) {
  let rows, total
  const visit = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 8) return
    for (const [key, value] of Object.entries(v)) {
      if (/^(totalCount|total_count|list_total_count|totalCnt)$/i.test(key) && Number.isSafeInteger(Number(value))) total = Number(value)
      if (/^(row|rows|item|items|data)$/i.test(key) && Array.isArray(value) && (value.length === 0 || value.every(r => r && typeof r === 'object' && !Array.isArray(r)))) rows = value
      if (key === 'item' && value && typeof value === 'object' && !Array.isArray(value)) rows = [value]
      if (/^(resultCode|returnReasonCode)$/i.test(key) && !['0','00','0000','INFO-000','INFO-0','NORMAL_SERVICE'].includes(String(value))) throw new SourceError(['20','30','31','32','33'].includes(String(value)) ? 'unauthorized' : 'failed', 'api_error')
      if (typeof value === 'object') visit(value, depth + 1)
    }
  }
  visit(json)
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total < 0) throw new SourceError('failed', 'unrecognized_page_schema')
  return { rows, total }
}

export async function collectPages(getPage, size = 100) {
  const all = [], hashes = new Set()
  let expected
  for (let page = 1; page <= 20000; page++) {
    const { rows, total } = await getPage(page, size)
    expected ??= total
    if (total !== expected || rows.length !== Math.min(size, expected - all.length)) throw new SourceError('failed', 'source_changed_or_short_page')
    if (rows.length) {
      const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
      if (hashes.has(hash)) throw new SourceError('failed', 'repeated_page')
      hashes.add(hash); all.push(...rows)
    }
    if (all.length === expected) return all
  }
  throw new SourceError('failed', 'page_limit')
}
