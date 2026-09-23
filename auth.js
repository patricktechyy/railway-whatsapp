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
    // Keep credentials in their own durable file so metadata saves (rename,
    // changelog acknowledgement, etc.) can never accidentally overwrite a
    // password that was just set through a setup/reset link.
    this.passwordFile = path.join(dataDir, 'passwords.json')
    this.secret = readOrCreate(path.join(dataDir, '.secret'), () => crypto.randomBytes(32).toString('hex'))

    // Prefer the documented variable, but keep compatibility with older
    // deployments and common aliases. Railway values sometimes arrive with
    // an accidental trailing newline, so only the admin environment value is
    // normalized here; user passwords remain byte-for-byte exact.
    const adminEnv = [
      ['ADMIN_PASSWORD', process.env.ADMIN_PASSWORD],
      ['PASSWORD', process.env.PASSWORD],
      ['ADMIN_PASS', process.env.ADMIN_PASS],
    ].find(([, value]) => typeof value === 'string' && value.length > 0)
    this.adminFromEnv = !!adminEnv
    this.adminEnvName = adminEnv?.[0] || null
    this.adminPassword =
      (adminEnv ? String(adminEnv[1]).replace(/\r?\n$/, '') : '') ||
      readOrCreate(path.join(dataDir, '.admin-password'), () => crypto.randomBytes(12).toString('base64url').slice(0, 16))
    this.adminPv = sha(this.adminPassword).slice(0, 12)

    this.users = []
    this.passwords = Object.create(null)
    this.usersMtime = 0
    this.passwordsMtime = 0
    this.failures = new Map()
    this.load()
    this.loadPasswords()
  }

  // ---------------------------------------------------------------- storage
  statMtime(file) {
    try { return fs.statSync(file).mtimeMs } catch { return 0 }
  }

  load() {
    try {
      this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || []
      this.usersMtime = this.statMtime(this.file)
    } catch {
      this.users = this.migrate()
      this.save()
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ users: this.users }, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)
    this.usersMtime = this.statMtime(this.file)
  }

  loadPasswords({ migrateLegacy = true } = {}) {
    const exists = fs.existsSync(this.passwordFile)
    try {
      const data = JSON.parse(fs.readFileSync(this.passwordFile, 'utf8'))
      this.passwords = data && typeof data.passwords === 'object' && data.passwords ? data.passwords : Object.create(null)
    } catch {
      this.passwords = Object.create(null)
    }

    // users.json remains the canonical credential source. passwords.json is
    // only a compatibility copy/fallback from the previous update.
    // A stale passwords.json entry must never overwrite a newer users.json hash.
    let repaired = false
    for (const u of this.users) {
      const fromUsers = typeof u.pass === 'string' && u.pass.startsWith('scrypt$') ? u.pass : null
      const fromPasswords = typeof this.passwords[u.username] === 'string' && this.passwords[u.username].startsWith('scrypt$')
        ? this.passwords[u.username]
        : null

      if (fromUsers) {
        if (this.passwords[u.username] !== fromUsers) {
          this.passwords[u.username] = fromUsers
          repaired = true
        }
      } else if (fromPasswords) {
        // Legacy account: restore the hash into users.json once.
        u.pass = fromPasswords
        repaired = true
      } else {
        u.pass = null
      }
    }
    if (!exists || repaired) this.savePasswords()
    if (repaired) this.save()
    this.passwordsMtime = this.statMtime(this.passwordFile)
  }

  // Other Railway processes/replicas can update the durable files while this
  // Node process is still alive. Refresh only when the on-disk version changes,
  // so login/reset/setup never relies on stale in-memory credentials.
  refresh() {
    const um = this.statMtime(this.file)
    const usersChanged = !!um && um !== this.usersMtime
    if (usersChanged) this.load()
    const pm = this.statMtime(this.passwordFile)
    if (usersChanged || pm !== this.passwordsMtime || (!pm && this.users.length)) this.loadPasswords()
  }

  savePasswords() {
    const tmp = `${this.passwordFile}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ passwords: this.passwords }, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.passwordFile)
  }

  storedPassword(u) {
    if (!u) return null
    // users.json is canonical. Only use passwords.json for an old account
    // whose canonical record does not yet contain a usable password hash.
    if (typeof u.pass === 'string' && u.pass.startsWith('scrypt$')) return u.pass
    const legacy = this.passwords[u.username]
    return typeof legacy === 'string' && legacy.startsWith('scrypt$') ? legacy : null
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
    this.refresh()
    return this.users.find((u) => u.username === username) || null
  }

  publicUser(u) {
    this.refresh()
    return {
      username: u.username,
      name: u.name,
      hasPassword: !!this.storedPassword(u),
      setupPending: !!(u.setup && u.setup.exp > Date.now()),
      createdAt: u.createdAt,
    }
  }

  create(username, name) {
    this.refresh()
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
    this.refresh()
    const i = this.users.findIndex((u) => u.username === username)
    if (i < 0) throw new HttpError(404, 'No such user')
    const [u] = this.users.splice(i, 1)
    delete this.passwords[u.username]
    this.savePasswords()
    this.save()
    return u
  }

  /** New one-time link. Clears the old password and signs the user out. */
  /** Remember when someone last used the site (kept in memory, saved every few minutes). */
  touch(username) {
    const u = this.get(username)
    if (!u) return
    const now = Date.now()
    u.lastActiveAt = now
    if (now - (u.lastActiveSavedAt || 0) > 5 * 60e3) { u.lastActiveSavedAt = now; this.save() }
  }

  markSeen(username, version) {
    this.refresh()
    const u = this.get(username)
    if (!u || u.seenVersion === version) return
    u.seenVersion = version
    this.save()
  }

  rename(username, name) {
    this.refresh()
    const u = this.get(username)
    if (!u) throw new HttpError(404, 'No such user')
    name = String(name || '').trim().slice(0, 60)
    if (!name) throw new HttpError(400, 'Display name cannot be empty')
    u.name = name
    this.save()
    return u
  }

  resetPassword(username) {
    this.refresh()
    const u = this.get(username)
    if (!u) throw new HttpError(404, 'No such user')
    u.pass = null
    delete this.passwords[u.username]
    u.pv = (u.pv || 1) + 1
    const token = this.issueSetup(u)
    this.savePasswords()
    this.save()
    return token
  }

  issueSetup(u) {
    const token = crypto.randomBytes(24).toString('base64url')
    u.setup = { hash: sha(token), exp: Date.now() + SETUP_TTL }
    return token
  }

  userForSetup(token) {
    this.refresh()
    if (!token) return null
    const h = sha(String(token))
    return this.users.find((u) => u.setup && eq(u.setup.hash, h) && u.setup.exp > Date.now()) || null
  }

  async completeSetup(token, password) {
    this.refresh()
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
    const encoded = `scrypt$${b64u(salt)}$${b64u(hash)}`
    u.pass = encoded
    this.passwords[u.username] = encoded
    u.pv = (u.pv || 1) + 1
    // Persist the credential separately first. The normal user metadata file
    // is updated afterwards, so even if another metadata write happens later
    // the password itself remains durable.
    this.savePasswords()
    this.save()
  }

  async checkPassword(u, password) {
    // hash even for unknown users so response time doesn't reveal who exists
    const stored = this.storedPassword(u) || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAA'
    const [, s, h] = stored.split('$')
    const got = await scrypt(String(password ?? ''), Buffer.from(s, 'base64url'), 64)
    const want = Buffer.from(h, 'base64url')
    return !!this.storedPassword(u) && want.length === got.length && crypto.timingSafeEqual(want, got)
  }

  async changePassword(username, current, next) {
    this.refresh()
    const u = this.get(username)
    if (!u) throw new HttpError(404, 'No such user')
    if (!(await this.checkPassword(u, current))) throw new HttpError(403, 'Current password is wrong')
    await this.setPassword(u, next)
    return u
  }

  // ------------------------------------------------------------------ login
  async login(ip, username, password) {
    this.refresh()
    username = String(username || '').trim().toLowerCase().slice(0, 40)
    const key = `${ip}|${username}`
    this.throttle(ip, key)
    if (username === 'admin') {
      if (eq(password, this.adminPassword)) return this.ok(key, { k: 'admin', u: 'admin', pv: this.adminPv })
      console.warn(`[auth] admin login failed: passwordLength=${String(password ?? '').length}, configuredBy=${this.adminEnvName || 'generated-file'}, configuredLength=${this.adminPassword.length}, ip=${ip}`)
    } else {
      const u = this.get(username)
      if (u && !this.storedPassword(u)) {
        this.fail(ip, key)
        throw new HttpError(403, 'This account has no password yet. Use the setup link you were sent.')
      }
      if (await this.checkPassword(u, password)) {
        u.lastLoginAt = Date.now()
        this.save()
        return this.ok(key, { k: 'user', u: u.username, pv: u.pv })
      }
      console.warn(`[auth] user login failed: username=${JSON.stringify(username)}, found=${!!u}, hasPassword=${!!u && !!this.storedPassword(u)}, passwordLength=${String(password ?? '').length}, ip=${ip}`)
    }
    this.fail(ip, key)
    throw new HttpError(401, 'Wrong username or password')
  }

  // 10 wrong passwords for one account from one address, or 100 wrong
  // passwords of any kind from one address, locks that for 15 minutes.
  // Per-account keys mean one person's typos at the office don't lock out
  // everyone else behind the same public IP.
  throttle(ip, key) {
    const window = 15 * 60 * 1000
    const hit = (k, max) => {
      const f = this.failures.get(k)
      return f && f.n >= max && Date.now() - f.t < window
    }
    if (hit(key, 10) || hit(`ip:${ip}`, 100)) {
      throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.')
    }
  }

  fail(ip, key) {
    const window = 15 * 60 * 1000
    for (const k of [key, `ip:${ip}`]) {
      const f = this.failures.get(k)
      if (!f || Date.now() - f.t > window) this.failures.set(k, { n: 1, t: Date.now() })
      else f.n++
    }
    if (this.failures.size > 20000) this.failures.clear()
  }

  ok(key, claims) {
    this.failures.delete(key)
    return claims
  }

  // ---------------------------------------------------------------- cookies
  sign(claims) {
    const body = b64u(JSON.stringify({ exp: Date.now() + COOKIE_TTL, ...claims }))
    const mac = crypto.createHmac('sha256', this.secret).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  /** Returns {k, u} for a valid, current cookie, else null. */

  verify(cookie) {
    this.refresh()
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
      return u && this.storedPassword(u) && u.pv === c.pv ? c : null
    }
    return null
  }
}
