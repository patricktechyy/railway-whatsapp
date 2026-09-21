import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from './session.js'
import { Auth, COOKIE, HttpError, MIN_PASSWORD } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Works both flat (repo root) and in the Docker layout (src/ + public/).
const PUBLIC = [path.join(__dirname, '..', 'public'), __dirname].find((d) =>
  fs.existsSync(path.join(d, 'chat.html'))
)

const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || '/data'
const BRAND = process.env.BRAND || 'WhatsApp Hub'
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024

fs.mkdirSync(DATA_DIR, { recursive: true })
const auth = new Auth(DATA_DIR)

// ------------------------------------------------------------- sessions ---
const sessions = new Map()

function startSession(user, delay = 0) {
  const s = new Session({ key: user.username, label: user.name, dir: path.join(DATA_DIR, user.dir) })
  sessions.set(user.username, s)
  s.schedule(delay)
  return s
}
// Stagger boot: every account reconnecting in the same instant from one IP
// is exactly what WhatsApp's rate limiting looks for.
auth.users.forEach((u, i) => startSession(u, i * 2000))

// --------------------------------------------------------------- helpers ---
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const templates = {}
const tpl = (f) => (templates[f] ??= fs.readFileSync(path.join(PUBLIC, f), 'utf8'))
const render = (f, vars) =>
  Object.entries({ BRAND, ...vars }).reduce((s, [k, v]) => s.replaceAll(`__${k}__`, esc(v)), tpl(f))

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...headers,
  })
  res.end(body)
}
const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' })
const page = (res, html) =>
  send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' })
const redirect = (res, to) => send(res, 302, '', { location: to })

const clientIp = (req) =>
  String(req.headers['x-real-ip'] || '').trim() ||
  String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() ||
  req.socket.remoteAddress ||
  '?'
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').startsWith('https')
const origin = (req) => `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`

function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(v.join('='))
  }
  return null
}
function setCookie(req, res, value, maxAge) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (isHttps(req)) attrs.push('Secure')
  res.setHeader('set-cookie', attrs.join('; '))
}
const whoami = (req) => auth.verify(readCookie(req))
const landing = (c) => (c?.k === 'admin' ? '/admin' : c?.k === 'user' ? `/u/${c.u}/` : '/')

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0)
    if (len > limit) return reject(new HttpError(413, `File too large (max ${Math.round(limit / 1048576)} MB)`))
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, `File too large (max ${Math.round(limit / 1048576)} MB)`))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
async function readJson(req) {
  const buf = await readBody(req, 1e6)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

// POSTs must be JSON (or our upload type) — a cross-site form can't set that,
// which together with SameSite cookies closes the CSRF door.
function requireJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json')
  }
}

function sse(req, res, s) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('retry: 3000\n\n')
  const push = (e) => {
    try {
      res.write(`data: ${JSON.stringify(e)}\n\n`)
    } catch {}
  }
  s.on('event', push)
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {}
  }, 25000)
  req.on('close', () => {
    clearInterval(ping)
    s.off('event', push)
  })
  push({ type: 'status', ...s.info() })
  s.wake()
}

// ---------------------------------------------------------------- routes ---
async function route(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  const M = req.method

  if (p === '/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain' })
  if (p === '/favicon.ico') return send(res, 204, '')

  // ---------------------------------------------------------- login/out
  if (p === '/' && M === 'GET') {
    const c = whoami(req)
    if (c) return redirect(res, landing(c))
    return page(res, render('login.html', {}))
  }
  if (p === '/api/login' && M === 'POST') {
    requireJson(req)
    const { username, password } = await readJson(req)
    const claims = await auth.login(clientIp(req), username, password)
    setCookie(req, res, auth.sign(claims), 30 * 24 * 3600)
    return json(res, { redirect: landing(claims) })
  }
  if (p === '/api/logout' && M === 'POST') {
    setCookie(req, res, '', 0)
    return json(res, { redirect: '/' })
  }

  // ------------------------------------------------------- setup links
  let m = p.match(/^\/setup\/([A-Za-z0-9_-]{20,64})$/)
  if (m && M === 'GET') {
    const u = auth.userForSetup(m[1])
    if (!u) return page(res, render('setup.html', { STATE: 'invalid', NAME: '', USERNAME: '', MIN: MIN_PASSWORD }))
    return page(res, render('setup.html', { STATE: 'ok', NAME: u.name, USERNAME: u.username, MIN: MIN_PASSWORD }))
  }
  if (p === '/api/setup' && M === 'POST') {
    requireJson(req)
    const { token, password } = await readJson(req)
    const u = await auth.completeSetup(token, password)
    const claims = { k: 'user', u: u.username, pv: u.pv }
    setCookie(req, res, auth.sign(claims), 30 * 24 * 3600)
    return json(res, { redirect: landing(claims) })
  }

  // --------------------------------------------------------------- admin
  if (p === '/admin' || p.startsWith('/admin/')) {
    const c = whoami(req)
    const isAdmin = c?.k === 'admin'
    if (p === '/admin' || p === '/admin/') {
      if (!isAdmin) return redirect(res, '/')
      return page(res, render('admin.html', { ADMIN_ENV: auth.adminFromEnv ? '1' : '0' }))
    }
    if (!isAdmin) throw new HttpError(401, 'Admin login required')

    if (p === '/admin/api/users' && M === 'GET') {
      return json(
        res,
        auth.users.map((u) => {
          const s = sessions.get(u.username)
          const info = s?.info() || {}
          return {
            ...auth.publicUser(u),
            status: s?.status || 'stopped',
            phone: s?.me?.phone || '',
            error: info.error ? [info.error.text, info.error.detail].filter(Boolean).join(' — ') : '',
            linked: !!info.linked,
          }
        })
      )
    }
    if (p === '/admin/api/users' && M === 'POST') {
      requireJson(req)
      const { username, name } = await readJson(req)
      const { user, token } = auth.create(username, name)
      startSession(user) // stays idle (no QR traffic) until they open their page
      console.log(`[admin] created user ${user.username}`)
      return json(res, { user: auth.publicUser(user), setupUrl: `${origin(req)}/setup/${token}` }, 201)
    }
    m = p.match(/^\/admin\/api\/users\/([^/]+)(?:\/(reset|unlink))?$/)
    if (m) {
      const username = decodeURIComponent(m[1])
      const action = m[2]
      if (!auth.get(username)) throw new HttpError(404, 'No such user')
      if (!action && M === 'DELETE') {
        const s = sessions.get(username)
        sessions.delete(username)
        auth.remove(username)
        await s?.destroy()
        console.log(`[admin] removed user ${username}`)
        return json(res, { ok: true })
      }
      if (M === 'POST') requireJson(req)
      if (action === 'reset' && M === 'POST') {
        const token = auth.resetPassword(username)
        return json(res, { setupUrl: `${origin(req)}/setup/${token}` })
      }
      if (action === 'unlink' && M === 'POST') {
        await sessions.get(username)?.relink()
        return json(res, { ok: true })
      }
    }
    throw new HttpError(404, 'Not found')
  }

  // ---------------------------------------------------------- user area
  m = p.match(/^\/u\/([a-z0-9][a-z0-9_.-]{1,31})(\/.*)?$/)
  if (!m) return send(res, 404, 'Not found')
  const username = m[1]
  const rest = m[2] || ''
  const c = whoami(req)
  const allowed = c?.k === 'user' && c.u === username

  if (rest === '' || rest === '/') {
    if (!allowed) return redirect(res, '/')
    if (rest === '') return redirect(res, `/u/${username}/`)
    const u = auth.get(username)
    sessions.get(username)?.wake()
    return page(res, render('chat.html', { USER: username, LABEL: u.name }))
  }
  if (!allowed) throw new HttpError(401, 'Please sign in again')
  const s = sessions.get(username)
  if (!s) throw new HttpError(404, 'Session not found')
  const api = rest.replace(/^\/api/, '')
  const jid = url.searchParams.get('jid')

  if (api === '/state') {
    s.wake()
    return json(res, s.info())
  }
  if (api === '/chats') return json(res, s.store.chatList())
  if (api === '/contacts') return json(res, s.store.contactList(url.searchParams.get('q') || ''))
  if (api === '/events') return sse(req, res, s)
  if (api === '/messages') {
    if (!jid) throw new HttpError(400, 'jid required')
    s.markRead(jid)
    return json(res, s.store.messageList(jid))
  }
  if (api === '/media') {
    const out = await s.media(jid, url.searchParams.get('id'))
    if (!out) throw new HttpError(404, 'Media not available')
    const headers = { 'content-type': out.mime, 'cache-control': 'private, max-age=86400' }
    if (out.fileName) headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(out.fileName)}`
    return send(res, 200, out.buffer, headers)
  }

  if (M !== 'POST') throw new HttpError(405, 'Method not allowed')

  if (api === '/send-media') {
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
    if (mime.startsWith('application/json')) throw new HttpError(415, 'Upload the file itself')
    if (!jid) throw new HttpError(400, 'jid required')
    const buf = await readBody(req, MAX_UPLOAD)
    if (!buf.length) throw new HttpError(400, 'Empty file')
    const thumbHeader = req.headers['x-thumb']
    const thumb = thumbHeader ? Buffer.from(String(thumbHeader), 'base64') : undefined
    const msg = await s.sendMedia(jid, buf, {
      mime,
      name: url.searchParams.get('name') || 'file',
      caption: (url.searchParams.get('caption') || '').slice(0, 4000),
      thumb: thumb?.length && thumb.length < 20000 ? thumb : undefined,
    })
    return json(res, msg)
  }

  requireJson(req)
  const body = await readJson(req)
  if (api === '/send') {
    const text = String(body.text || '').trim()
    if (!body.jid || !text) throw new HttpError(400, 'jid and text required')
    if (text.length > 65000) throw new HttpError(400, 'Message too long')
    return json(res, await s.send(body.jid, text))
  }
  if (api === '/resolve') return json(res, await s.resolveNumber(body.phone))
  if (api === '/pair') return json(res, await s.pairingCode(body.phone))
  if (api === '/older') {
    if (!body.jid) throw new HttpError(400, 'jid required')
    return json(res, await s.fetchOlder(body.jid))
  }
  if (api === '/relink') {
    await s.relink()
    return json(res, { ok: true })
  }
  if (api === '/password') {
    const u = await auth.changePassword(username, body.current, body.next)
    setCookie(req, res, auth.sign({ k: 'user', u: u.username, pv: u.pv }), 30 * 24 * 3600)
    return json(res, { ok: true })
  }
  throw new HttpError(404, 'Not found')
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res)
  } catch (e) {
    const status = e.status || 500
    if (status >= 500) console.error('request failed:', req.method, req.url, e)
    if (!res.headersSent) json(res, { error: status >= 500 ? 'Something went wrong: ' + e.message : e.message }, status)
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log('')
  console.log(`  ${BRAND} on port ${PORT} — ${auth.users.length} user(s)`)
  for (const u of auth.users) console.log(`    /u/${u.username}/  ${u.name}${u.pass ? '' : '  (no password yet)'}`)
  console.log('    admin login: username "admin"')
  if (!auth.adminFromEnv) console.log(`    admin password: ${auth.adminPassword}   (set ADMIN_PASSWORD to choose your own)`)
  console.log('')
})

// One broken request or one flaky session must never take the others down.
process.on('uncaughtException', (e) => console.error('uncaught:', e))
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e))
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})
const bye = () => {
  for (const s of sessions.values()) s.shutdown()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
