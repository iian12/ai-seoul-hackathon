import { readFile, readdir } from 'node:fs/promises'
const content = await readFile('.env.server.local', 'utf8').catch(() => '')
const secrets = content.split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => l.slice(l.indexOf('=') + 1).trim()).filter(v => v.length > 8)
async function walk(dir) {
  const files = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(files.map(f => f.isDirectory() ? walk(`${dir}/${f.name}`) : [`${dir}/${f.name}`]))).flat()
}
let failed = false
for (const file of await walk('dist')) {
  const body = await readFile(file, 'utf8')
  if (secrets.some(s => body.includes(s) || body.includes(encodeURIComponent(s)))) failed = true
}
console.log(failed ? 'FAIL: 프런트엔드 빌드에 서버 비밀값이 포함됐습니다.' : `PASS: 프런트엔드 빌드에 로컬 서버 비밀값 ${secrets.length}개가 포함되지 않았습니다.`)
if (failed) process.exitCode = 1
