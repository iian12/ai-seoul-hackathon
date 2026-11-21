import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const archiveUrl = process.env.SEOUL_DATA_ARCHIVE_URL
if (archiveUrl) {
  const url = new URL(archiveUrl)
  const checksum = url.pathname.match(/\/seoul-sai-public-([a-f0-9]{64})\.tar\.gz$/)?.[1]
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.private.blob.vercel-storage.com')
    || url.username || url.password || url.port || !checksum) {
    throw new Error('Invalid Seoul data archive URL')
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new Error('Connect the private Blob store before fetching the Seoul data archive')

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Seoul data archive download failed (HTTP ${response.status})`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== checksum) {
    throw new Error('Seoul data archive checksum does not match')
  }

  const temp = await mkdtemp(join(tmpdir(), 'seoul-vercel-data-'))
  try {
    const tar = join(temp, 'snapshot.tar.gz')
    await writeFile(tar, archive)
    const extract = (name) => execFileSync('tar', ['-xOzf', tar, name], { maxBuffer: 48 * 1024 * 1024 })
    const pointer = extract('current.json')
    const manifest = JSON.parse(pointer.toString('utf8'))
    const files = {
      snapshot: 'seoul-snapshot.json',
      gzip: 'seoul-snapshot.json.gz',
      points: 'point-facilities.json',
      walk: 'point-walk.bin',
    }
    const releaseDir = typeof manifest.snapshot === 'string'
      ? manifest.snapshot.match(/^(\/data\/releases\/[A-Za-z0-9_-]+\/)seoul-snapshot\.json$/)?.[1]
      : undefined
    if (manifest.version !== 1 || !releaseDir || Object.entries(files).some(([key, name]) => manifest[key] !== releaseDir + name)) {
      throw new Error('Invalid Seoul data release manifest')
    }
    for (const path of [...Object.keys(files).map(key => manifest[key].slice('/data/'.length)), 'seoul-places.json']) {
      const target = join('public/data', path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, extract(path))
    }
    await writeFile('public/data/current.json', pointer)
    console.log('Installed verified Seoul public aggregate files from Vercel Blob.')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
