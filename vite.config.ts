import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

/**
 * 개발 서버에서도 /api/* 서버리스 함수(Vercel과 같은 파일)를 그대로 실행한다.
 * 배포는 Vercel이 api/ 폴더를 함수로 올리므로 이 플러그인은 개발할 때만 쓴다.
 * Groq 키는 .env.server.local에서 개발 서버의 API에만 전달한다.
 */
function devApi(): Plugin {
  return {
    name: 'seoulsai-dev-api',
    apply: 'serve',
    configureServer(server) {
      if (existsSync('.env.server.local')) {
        const localEnv = parseEnv(readFileSync('.env.server.local', 'utf8'))
        for (const name of ['GROQ_API_KEY', 'GROQ_API_KEYS']) {
          const value = localEnv[name]
          if (value) process.env[name] ??= value
        }
      }
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        const m = url.match(/^\/api\/([a-z-]+)(?:\?|$)/)
        if (!m) return next()
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`) as Record<string, unknown>
          const handler = mod[req.method ?? 'GET']
          if (typeof handler !== 'function') { res.statusCode = 405; res.end(); return }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
          const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${url}`, { method: req.method, headers, body: chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(Buffer.concat(chunks)) : undefined })
          const response = await (handler as (r: Request) => Promise<Response>)(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          if (e instanceof Error) server.ssrFixStacktrace(e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: '개발 서버에서 AI 함수를 실행하지 못했어요.' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))) }
  const allowed = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']
  const hasUnexpectedEnv = Object.entries(env).some(([name, value]) => {
    const vercelMetadata = process.env.VERCEL === '1' && name.startsWith('VITE_VERCEL_')
    return value && !allowed.includes(name) && !vercelMetadata
  })
  if (hasUnexpectedEnv) throw new Error('허용되지 않은 VITE_ 환경변수입니다. 비밀키는 .env.server.local의 서버 전용 변수에 저장하세요.')
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
  let serviceRole = false
  try { serviceRole = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'service_role' } catch { /* publishable keys are not JWTs */ }
  if (key.startsWith('sb_secret_') || serviceRole) throw new Error('Supabase 비밀키는 프런트엔드에 사용할 수 없습니다. publishable 또는 anon 키를 사용하세요.')
  return { envPrefix: allowed, plugins: [react(), devApi()], server: { port: 5173, strictPort: true }, build: { rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'], map: ['leaflet'], supabase: ['@supabase/supabase-js'] } } } } }
})
