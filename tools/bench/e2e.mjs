// node e2e.mjs <old|new> <dataDir> <port>
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [which, dataDir, port] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const base = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = 60

const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(here, 'preload.mjs')).href, path.join(here, which, 'server.js')], {
  env: { ...process.env, PORT: port, DATA_DIR: dataDir, ADMIN_PASSWORD: 'bench', MEM_LOG_MS: '0', FAKE_MEDIA_MB: String(MB), WA_LOG: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))
const rss = () => {
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' })
      return Math.round(Number(out.trim()) / 1024)
    }
    const out = execFileSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return Math.round(Number((out.trim().split('","').pop() || '').replace(/[^\d]/g, '')) / 1024)
  } catch { return 0 }
}
let peak = 0
const sampler = setInterval(() => { peak = Math.max(peak, rss()) }, 80)
const phase = async (name, fn) => {
  await sleep(1500) // let it settle
  const before = rss()
  peak = before
  const result = await fn()
  const after = peak
  return { name, rssBeforeMB: before, peakDuringMB: after, grewByMB: after - before, ...result }
}
async function req(p, opts = {}, cookie) {
  return fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) } })
}

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break } catch {} await sleep(100) }
  const login = await req('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'user0', password: 'benchpass' }) })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  if (!login.ok || !cookie) throw new Error(`User login failed: HTTP ${login.status}`)
  const u = '/u/user0/api'
  for (let i = 0; i < 100; i++) { const st = await (await req(`${u}/state`, {}, cookie)).json(); if (st.status === 'connected') break; await sleep(100) }
  const chats = await (await req(`${u}/chats`, {}, cookie)).json()
  // find three photos
  const photos = []
  for (const c of chats) {
    const list = await (await req(`${u}/messages?jid=${encodeURIComponent(c.jid)}&limit=200`, {}, cookie)).json()
    for (const m of list) if (m.media && photos.length < 3) photos.push({ jid: c.jid, id: m.id })
    if (photos.length >= 3) break
  }
  if (photos.length !== 3) throw new Error('The synthetic account needs at least three photos')
  const results = []
  const expected = crypto.createHash('sha256')
  for (let i = 0; i < (MB * 1048576) / 65536; i++) expected.update(Buffer.alloc(65536, i & 255))
  const want = expected.digest('hex')

  results.push(await phase(`three ${MB} MB photos opened at once`, async () => {
    const got = await Promise.all(photos.map(async (p) => {
      const r = await req(`${u}/media?jid=${encodeURIComponent(p.jid)}&id=${encodeURIComponent(p.id)}`, {}, cookie)
      const h = crypto.createHash('sha256')
      let n = 0
      for await (const c of r.body) { h.update(c); n += c.length }
      return { status: r.status, bytes: n, ok: h.digest('hex') === want, contentLength: r.headers.get('content-length'), type: r.headers.get('content-type'), cache: r.headers.get('cache-control') }
    }))
    return { responses: got }
  }))

  results.push(await phase('one 24 MB file sent', async () => {
    const body = Buffer.alloc(24 * 1048576, 7)
    const r = await req(`${u}/send-media?jid=${encodeURIComponent(chats[0].jid)}&name=big.bin`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body }, cookie)
    const j = await r.json()
    return { status: r.status, reply: j.error || 'sent' }
  }))
  results.push(await phase('an upload over the 25 MB limit', async () => {
    const r = await req(`${u}/send-media?jid=${encodeURIComponent(chats[0].jid)}&name=huge.bin`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(26 * 1048576, 1) }, cookie).catch((e) => ({ status: `refused (${e.cause?.code || e.message})`, json: async () => ({}) }))
    return { status: r.status }
  }))
  await sleep(500)
  const spool = path.join(os.tmpdir(), 'wa-spool')
  const spoolAfter = fs.existsSync(spool) ? fs.readdirSync(spool).length : null
  console.log(JSON.stringify({ which, results, filesLeftInSpool: which === 'new' ? spoolAfter : 'n/a' }, null, 1))
  const [download, upload, rejected] = results
  if (download.responses.some((r) => r.status !== 200 || !r.ok) ||
      upload.status !== 200 || rejected.status !== 413 ||
      (which === 'new' && spoolAfter !== 0)) process.exitCode = 1
} finally {
  clearInterval(sampler)
  child.kill()
  await sleep(300)
  if (process.env.SHOW_LOG) console.log(log.split('\n').filter((l) => /error|failed|\[boot\]/i.test(l)).slice(0, 10).join('\n'))
}
