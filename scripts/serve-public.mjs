// Serve only the built distribution for a public tunnel. Never expose the project root.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { resolve, relative, extname, isAbsolute } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const root = await realpath(resolve('dist'))
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  const fail = (status) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(status === 404 ? 'Not found' : 'Request denied') }
  if (!['GET', 'HEAD'].includes(req.method)) { fail(405); return }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname.split('/').some(p => p.startsWith('.') || p.includes('\\'))) { fail(404); return }
    const requested = resolve(root, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '')
    const file = await realpath(requested)
    const rel = relative(root, file)
    if (rel.startsWith('..') || isAbsolute(rel)) { fail(404); return }
    const info = await stat(file)
    if (!info.isFile()) { fail(404); return }
    const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`
    const headers = { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300', 'ETag': etag, 'Vary': 'Accept-Encoding' }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
    const gzip = /(?:^|[,\s])gzip(?:[,;\s]|$)/.test(req.headers['accept-encoding'] || '') && /\.(json|js|css|html|svg)$/.test(file)
    if (gzip) headers['Content-Encoding'] = 'gzip'
    else headers['Content-Length'] = info.size
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    if (gzip) await pipeline(createReadStream(file), createGzip({ level: 6 }), res)
    else await pipeline(createReadStream(file), res)
  } catch { if (!res.headersSent) fail(404); else res.destroy() }
})
server.listen(4173, '127.0.0.1', () => console.log('Seoul Sai public build: http://127.0.0.1:4173 (dist only)'))
