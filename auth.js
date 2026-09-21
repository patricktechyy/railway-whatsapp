import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)

const SETUP_TTL = 7 * 24 * 3600 * 1000 // setup links live for 7 days
const COOKIE_TTL = 30 * 24 * 3600 * 1000
export const COOKIE = 'wah'

const RESERVED = new Set(['admin', 'api', 'login', 'logout', 'setup', 'healthz', 'u', 'static', 'root'])
export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/
export const MIN_PASSWORD = 8

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const b64u = (b) => Buffer.from(b).toString('base64url')

function readOrCreate(file, make) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (v) return v
  } catch {}
  const v = make()
  fs.writeFileSync(file, v, { mode: 0o600 })
  return v
}

function eq(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export class Auth {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'users.json')
    this.secret = readOrCreate(path.join(dataDir, '.secret'), () => crypto.randomBytes(32).toString('hex'))

    // ADMIN_PASSWORD wins; the old PASSWORD variable still works so an
    // existing deploy keeps its login; otherwise generate one and keep it.
    this.adminFromEnv = !!(process.env.ADMIN_PASSWORD || process.env.PASSWORD)
    this.adminPassword =
      process.env.ADMIN_PASSWORD ||
      process.env.PASSWORD ||
      readOrCreate(path.join(dataDir, '.admin-password'), () => crypto.randomBytes(12).toString('base64url').slice(0, 16))
    this.adminPv = sha(this.adminPassword).slice(0, 12)

    this.users = []
    this.failures = new Map()
    this.load()
  }

  // ---------------------------------------------------------------- storage
  load() {
    try {
      this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || []
    } catch {
      this.users = this.migrate()
      this.save()
    }
  }

  save() {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  /**
   * First boot on the new version: adopt the old /data/session-N folders so
   * nobody loses their linked device. They get no password until you send
   * them a setup link from the admin page.
   */
  migrate() {
    let dirs = []
    try {
      dirs = fs
        .readdirSync(this.dataDir)
        .map((d) => d.match(/^session-(\d+)$/))
        .filter(Boolean)
        .sort((a, b) => a[1] - b[1])
    } catch {}
    if (!dirs.length) return []
    const names = (process.env.NAMES || '').split(',').map((s) => s.trim())
    const taken = new Set()
    const out = dirs.map(([dir, n]) => {
      const label = names[n - 1] || `User ${n}`
      let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
      if (!USERNAME_RE.test(base) || RESERVED.has(base)) base = `user${n}`
      let username = base
      for (let i = 2; taken.has(username); i++) username = `${base}${i}`
      taken.add(username)
      return { username, name: label, dir, pass: null, pv: 1, setup: null, createdAt: Date.now() }
    })
    console.log(`  migrated ${out.length} existing session(s): ${out.map((u) => u.username).join(', ')}`)
    console.log('  open /admin and create setup links so each person can pick a password')
    return out
  }

  // ------------------------------------------------------------------ users
  get(username) {
    return this.users.find((u) => u.username === username) || null
  }

  publicUser(u) {
    return {
      username: u.username,
      name: u.name,
      hasPassword: !!u.pass,
      setupPending: !!(u.setup && u.setup.exp > Date.now()),
      createdAt: u.createdAt,
    }
  }

  create(username, name) {
    username = String(username || '').trim().toLowerCase()
    name = String(name || '').trim().slice(0, 60) || username
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Username: 2–32 characters, lowercase letters, numbers, dot, dash or underscore')
    }
    if (RESERVED.has(username)) throw new HttpError(400, `"${username}" is reserved, pick another`)
    if (this.get(username)) throw new HttpError(409, `"${username}" already exists`)
    const user = {
      username,
      name,
      dir: path.join('accounts', `${username}-${crypto.randomBytes(4).toString('hex')}`),
      pass: null,
      pv: 1,
      setup: null,
      createdAt: Date.now(),
    }
    this.users.push(user)
    const token = this.issueSetup(user)
    this.save()
    return { user, token }
  }

  remove(username) {
    const i = this.users.findIndex((u) => u.username === username)
    if (i < 0) throw new HttpError(404, 'No such user')
    const [u] = this.users.splice(i, 1)
    this.save()
    return u
  }

  rename(username, name) {
    const u = this.get(username)
    if (!u) throw new HttpError(404, 'No such user')
    u.name = String(name || '').trim().slice(0, 60) || u.username
    this.save()
    return u
  }

  /** New one-time link. Clears the old password and signs the user out. */
  resetPassword(username) {
    const u = this.get(username)
    if (!u) throw new HttpError(404, 'No such user')
    u.pass = null
    u.pv = (u.pv || 1) + 1
    const token = this.issueSetup(u)
    this.save()
    return token
  }

  issueSetup(u) {
    const token = crypto.randomBytes(24).toString('base64url')
    u.setup = { hash: sha(token), exp: Date.now() + SETUP_TTL }
    return token
  }

  userForSetup(token) {
    if (!token) return null
    const h = sha(String(token))
    return this.users.find((u) => u.setup && eq(u.setup.hash, h) && u.setup.exp > Date.now()) || null
  }

  async completeSetup(token, password) {
    const u = this.userForSetup(token)
    if (!u) throw new HttpError(410, 'This setup link is invalid or has expired. Ask for a new one.')
    await this.setPassword(u, password)
    u.setup = null
    this.save()
    return u
  }

  async setPassword(u, password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`)
    }
    if (password.length > 200) throw new HttpError(400, 'Password is too long')
    const salt = crypto.randomBytes(16)
    const hash = await scrypt(password, salt, 64)
    u.pass = `scrypt$${b64u(salt)}$${b64u(hash)}`
    u.pv = (u.pv || 1) + 1
    this.save()
  }

  async checkPassword(u, password) {
    // hash even for unknown users so response time doesn't reveal who exists
    const stored = u?.pass || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAA'
    const [, s, h] = stored.split('$')
    const got = await scrypt(String(password ?? ''), Buffer.from(s, 'base64url'), 64)
    const want = Buffer.from(h, 'base64url')
    return !!u?.pass && want.length === got.length && crypto.timingSafeEqual(want, got)
  }

  async changePassword(username, current, next) {
    const u = this.get(username)
    if (!u) throw new HttpError(404, 'No such user')
    if (!(await this.checkPassword(u, current))) throw new HttpError(403, 'Current password is wrong')
    await this.setPassword(u, next)
    return u
  }

  // ------------------------------------------------------------------ login
  async login(ip, username, password) {
    username = String(username || '').trim().toLowerCase()
    this.throttle(ip)
    if (username === 'admin') {
      if (eq(password, this.adminPassword)) return this.ok(ip, { k: 'admin', u: 'admin', pv: this.adminPv })
    } else {
      const u = this.get(username)
      if (u && !u.pass) {
        this.fail(ip)
        throw new HttpError(403, 'This account has no password yet. Use the setup link you were sent.')
      }
      if (await this.checkPassword(u, password)) return this.ok(ip, { k: 'user', u: u.username, pv: u.pv })
    }
    this.fail(ip)
    throw new HttpError(401, 'Wrong username or password')
  }

  throttle(ip) {
    const f = this.failures.get(ip)
    if (f && f.n >= 10 && Date.now() - f.t < 15 * 60 * 1000) {
      throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.')
    }
  }

  fail(ip) {
    const f = this.failures.get(ip)
    if (!f || Date.now() - f.t > 15 * 60 * 1000) this.failures.set(ip, { n: 1, t: Date.now() })
    else f.n++
    if (this.failures.size > 5000) this.failures.clear()
  }

  ok(ip, claims) {
    this.failures.delete(ip)
    return claims
  }

  // ---------------------------------------------------------------- cookies
  sign(claims) {
    const body = b64u(JSON.stringify({ ...claims, exp: Date.now() + COOKIE_TTL }))
    const mac = crypto.createHmac('sha256', this.secret).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  /** Returns {k, u} for a valid, current cookie, else null. */
  verify(cookie) {
    if (!cookie || !cookie.includes('.')) return null
    const [body, mac] = cookie.split('.')
    const want = crypto.createHmac('sha256', this.secret).update(body).digest('base64url')
    if (!eq(mac, want)) return null
    let c
    try {
      c = JSON.parse(Buffer.from(body, 'base64url').toString())
    } catch {
      return null
    }
    if (!c || c.exp < Date.now()) return null
    if (c.k === 'admin') return c.pv === this.adminPv ? c : null
    if (c.k === 'user') {
      const u = this.get(c.u)
      // password change / reset bumps pv, which signs out old cookies
      return u && u.pass && u.pv === c.pv ? c : null
    }
    return null
  }
}
