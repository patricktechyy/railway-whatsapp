import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Session } from './session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, '..', 'public')

const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || '/data'
const COUNT = Math.max(1, Number(process.env.SESSIONS || 3))
const BRAND = process.env.BRAND || 'WhatsApp Hub'
const USERNAME = process.env.USERNAME || 'wa'
const LABELS = (process.env.NAMES || '').split(',').map((s) => s.trim())

fs.mkdirSync(DATA_DIR, { recursive: true })

// ------------------------------------------------------------- password ---
// One PASSWORD opens everything unless PASS_1 / PASS_2 / ... are set.
// If unset, generate once and keep it on the volume so it stays stable.
let PASSWORD = process.env.PASSWORD
if (!PASSWORD) {
  const f = path.join(DATA_DIR, '.password')
  try {
    PASSWORD = fs.readFileSync(f, 'utf8').trim()
  } catch {
    /* not generated yet */
  }
  if (!PASSWORD) {
    PASSWORD = crypto.randomBytes(12).toString('base64url').slice(0, 16)
    fs.writeFileSync(f, PASSWORD, { mode: 0o600 })
  }
}

const creds = (i) => ({
  user: process.env[`USER_${i}`] || USERNAME,
  pass: process.env[`PASS_${i}`] || PASSWORD,
})

function eq(a = '', b = '') {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

function authed(req, i) {
  const h = req.headers.authorization || ''
  if (!h.startsWith('Basic ')) return false
  const raw = Buffer.from(h.slice(6), 'base64').toString()
  const sep = raw.indexOf(':')
  const u = raw.slice(0, sep)
  const p = raw.slice(sep + 1)
  const check = (c) => eq(u, c.user) && eq(p, c.pass)
  if (i === null) {
    for (let k = 1; k <= COUNT; k++) if (check(creds(k))) return true
    return false
  }
  return check(creds(i))
}

// ------------------------------------------------------------- sessions ---
const sessions = new Map()
for (let i = 1; i <= COUNT; i++) {
  const s = new Session({
    id: i,
    label: LABELS[i - 1] || `Session ${i}`,
    dir: path.join(DATA_DIR, `session-${i}`),
  })
  sessions.set(i, s)
  s.start().catch((e) => console.error(`[${i}] start failed:`, e))
}

// --------------------------------------------------------------- helpers ---
const html = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8')

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers })
  res.end(body)
}
const json = (res, obj, code = 200) =>
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' })
const page = (res, body) =>
  send(res, 200, body, { 'content-type': 'text/html; charset=utf-8' })
// Header values must be ASCII, and quotes would break the realm syntax.
// Getting this wrong means a single failed login takes the process down.
const realmSafe = (s) =>
  String(s).replace(/[^\x20-\x7E]/g, ' ').replace(/["\\]/g, '').trim() || 'Restricted'

const unauthorized = (res, realm) =>
  send(res, 401, 'Authentication required', {
    'www-authenticate': `Basic realm="${realmSafe(realm)}", charset="UTF-8"`,
  })

function body(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
  })
}

function portalPage() {
  const cards = [...sessions.values()]
    .map(
      (s) => `
      <a class="card" href="/${s.id}/">
        <span class="num">${s.id}</span>
        <span class="meta"><strong>${esc(s.label)}</strong><small id="st${s.id}">…</small></span>
        <span class="go">Open &rarr;</span>
      </a>`
    )
    .join('')
  return html('portal.html')
    .replaceAll('__BRAND__', esc(BRAND))
    .replace('__CARDS__', cards)
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )

// ----------------------------------------------------------------- routes ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain' })
  if (p === '/favicon.ico') return send(res, 204, '')

  // portal
  if (p === '/' || p === '') {
    if (!authed(req, null)) return unauthorized(res, BRAND)
    return page(res, portalPage())
  }
  if (p === '/api/status') {
    if (!authed(req, null)) return unauthorized(res, BRAND)
    return json(
      res,
      [...sessions.values()].map((s) => ({ id: s.id, label: s.label, status: s.status }))
    )
  }

  const m = p.match(/^\/(\d+)(\/.*)?$/)
  if (!m) return send(res, 404, 'Not found')

  const i = Number(m[1])
  const s = sessions.get(i)
  if (!s) return send(res, 404, 'No such session')
  if (!authed(req, i)) return unauthorized(res, `${BRAND} — ${s.label}`)

  const rest = m[2] || '/'
  if (rest === '/') {
    if (!m[2]) return send(res, 302, '', { location: `/${i}/` })
    return page(
      res,
      html('chat.html').replaceAll('__LABEL__', esc(s.label)).replaceAll('__ID__', String(i))
    )
  }

  try {
    if (rest === '/api/state') {
      return json(res, { status: s.status, qr: s.qr, me: s.me, label: s.label })
    }
    if (rest === '/api/chats') {
      return json(res, s.store.chatList())
    }
    if (rest === '/api/messages') {
      const jid = url.searchParams.get('jid')
      if (!jid) return json(res, { error: 'jid required' }, 400)
      s.markRead(jid)
      return json(res, s.store.messageList(jid))
    }
    if (rest === '/api/send' && req.method === 'POST') {
      const { jid, text } = await body(req)
      if (!jid || !text?.trim()) return json(res, { error: 'jid and text required' }, 400)
      const msg = await s.send(jid, text.trim())
      return json(res, msg)
    }
    if (rest === '/api/logout' && req.method === 'POST') {
      await s.logout()
      return json(res, { ok: true })
    }
    if (rest === '/api/media') {
      const id = url.searchParams.get('id')
      const out = await s.media(id)
      if (!out) return send(res, 404, 'Media not available')
      return send(res, 200, out.buffer, {
        'content-type': out.mime,
        'cache-control': 'private, max-age=3600',
      })
    }
    if (rest === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      const onEvent = (e) => {
        try {
          res.write(`data: ${JSON.stringify(e)}\n\n`)
        } catch {
          /* client vanished */
        }
      }
      s.on('event', onEvent)
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => {
        clearInterval(ping)
        s.off('event', onEvent)
      })
      onEvent({ type: 'status', status: s.status, qr: s.qr, me: s.me })
      return
    }
  } catch (e) {
    return json(res, { error: e.message }, 500)
  }

  return send(res, 404, 'Not found')
})

server.listen(PORT, () => {
  console.log('')
  console.log(`  ${BRAND} — ${COUNT} session(s) on port ${PORT}`)
  for (const s of sessions.values()) {
    console.log(`    /${s.id}  ${s.label}  ->  user: ${creds(s.id).user}`)
  }
  console.log(`    password: ${PASSWORD}`)
  console.log('    (set the PASSWORD variable to choose your own)')
  console.log('')
})

// A single malformed request, or a hiccup in one session, must never take
// down the other sessions.
process.on('uncaughtException', (e) => console.error('uncaught:', e))
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e))
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

const bye = () => {
  for (const s of sessions.values()) s.store.flush()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
