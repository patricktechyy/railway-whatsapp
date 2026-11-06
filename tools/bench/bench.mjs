// node bench.mjs <old|new> <dataDir> <port> [accounts=12]
// Starts that version's server on the data, logs everyone in, reads their chats and messages, and watches memory.
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [which, dataDir, port, nAcc = '12'] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, which, 'server.js')
const base = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(here, 'preload.mjs')).href, server], {
  env: { ...process.env, PORT: port, DATA_DIR: dataDir, ADMIN_PASSWORD: 'bench', MEM_LOG_MS: '0', WA_LOG: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const t0 = Date.now()
let listenAt = null
let log = ''
child.stdout.on('data', (d) => { log += d; if (listenAt === null && /on port/.test(log)) listenAt = Date.now() - t0 })
child.stderr.on('data', (d) => { log += d })

const rssMB = () => {
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' })
      return Math.round(Number(out.trim()) / 1024)
    }
    const out = execFileSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    const kb = Number((out.trim().split('","').pop() || '').replace(/[^\d]/g, ''))
    return Math.round(kb / 1024)
  } catch { return 0 }
}
let max = 0
const samples = []
const sampler = setInterval(() => { const m = rssMB(); if (m) { samples.push([Date.now() - t0, m]); max = Math.max(max, m) } }, 250)

async function post(p, body, cookie) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
  return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0], json: await r.json().catch(() => ({})) }
}
async function get(p, cookie) {
  const r = await fetch(base + p, { headers: cookie ? { cookie } : {} })
  const text = await r.text()
  return { status: r.status, text }
}

try {
  // the server answers its health check while it is still starting
  let health = null
  for (let i = 0; i < 100 && health === null; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) health = Date.now() - t0 } catch {}
    if (health === null) await sleep(100)
  }
  const admin = await post('/api/login', { username: 'admin', password: 'bench' })
  if (!admin.r.ok || !admin.cookie) throw new Error(`Admin login failed: HTTP ${admin.r.status}`)
  const ready = Date.now() - t0
  const readyRss = rssMB()
  const n = Number(nAcc)
  // everybody signs in and opens their chats, the first dozen conversations, and a page back
  const cookies = []
  for (let a = 0; a < n; a++) cookies.push((await post('/api/login', { username: `user${a}`, password: 'benchpass' })).cookie)
  let calls = 0, bytes = 0, failures = 0
  const t1 = Date.now()
  for (let round = 0; round < 3; round++) {
    for (let a = 0; a < n; a++) {
      const u = `/u/user${a}/api`
      const chats = await get(`${u}/chats`, cookies[a])
      calls++; bytes += chats.text.length
      if (chats.status !== 200) { failures++; continue }
      const list = JSON.parse(chats.text)
      for (const c of list.slice(0, 12)) {
        const m = await get(`${u}/messages?jid=${encodeURIComponent(c.jid)}&limit=200`, cookies[a])
        calls++; bytes += m.text.length
        if (m.status !== 200) failures++
      }
      const first = list[0]
      if (!first) { failures++; continue }
      const msgs = JSON.parse((await get(`${u}/messages?jid=${encodeURIComponent(first.jid)}&limit=200`, cookies[a])).text)
      if (msgs.length) {
        const older = await get(`${u}/messages?jid=${encodeURIComponent(first.jid)}&limit=200&beforeId=${encodeURIComponent(msgs[0].id)}`, cookies[a])
        calls++; bytes += older.text.length
        const media = await get(`${u}/chat-media?jid=${encodeURIComponent(first.jid)}`, cookies[a])
        calls++; bytes += media.text.length
        if (older.status !== 200 || media.status !== 200) failures++
      }
      const health = await get(`${u}/health`, cookies[a])
      if (health.status !== 200) failures++
    }
  }
  const loadMs = Date.now() - t1
  const peakDuringLoad = max
  const stats = JSON.parse((await get('/admin/api/stats', admin.cookie)).text)
  await sleep(12000) // settle
  const tail = samples.slice(-8).map((s) => s[1]).sort((x, y) => x - y)
  const idle = tail[Math.floor(tail.length / 2)]
  const h = JSON.parse((await get('/u/user0/api/health', cookies[0])).text)
  console.log(JSON.stringify({
    which, listenMs: listenAt, healthzAnsweredMs: health, readyMs: ready, rssWhenReadyMB: readyRss,
    loadRounds: { calls, MBdownloaded: Math.round(bytes / 1048576), ms: loadMs, failures },
    peakRssMB: max, peakDuringLoadMB: peakDuringLoad, idleRssMB: idle, reportedByServerMB: stats.memoryMB,
    sampleStore: h.store && { messages: h.store.messages, chats: h.store.chats, bytes: h.store.bytes },
  }, null, 1))
  if (failures || !max) process.exitCode = 1
} finally {
  clearInterval(sampler)
  child.kill()
  await sleep(500)
  if (process.env.SHOW_LOG) console.log(log.split('\n').filter((l) => /\[store\]|boot|failed|error/i.test(l)).slice(0, 20).join('\n'))
}
