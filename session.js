import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { Store, bare, isGroup, isLid, isPn, phoneOf, toPn } from './store.js'

// Ask the phone for the full backlog at pairing time. Set FULL_HISTORY=0 to
// only take the recent slice (lighter pairing spike on huge accounts).
const FULL_HISTORY = process.env.FULL_HISTORY !== '0'

// Baileys wants a pino-shaped logger. This one prints compact lines to the
// Railway logs without pulling pino into the image.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 99 }
function makeLogger(prefix, level) {
  const min = LEVELS[level] ?? LEVELS.warn
  const emit = (lvl) => (a, b) => {
    if (LEVELS[lvl] < min) return
    const msg = typeof a === 'string' ? a : typeof b === 'string' ? b : ''
    let extra = ''
    if (a && typeof a === 'object') {
      try {
        const o = { ...a }
        delete o.class
        if (o.trace) {
          extra += ' | ' + String(o.trace).split('\n')[0]
          delete o.trace
        }
        if (o.err) {
          extra += ' | ' + (o.err.message || String(o.err))
          delete o.err
        }
        const j = JSON.stringify(o, (k, v) =>
          v && v.type === 'Buffer' ? '<bytes>' : typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v
        )
        if (j && j !== '{}') extra += ' ' + j.slice(0, 500)
      } catch {
        extra += ' [unprintable]'
      }
    }
    console.log(`${prefix} wa.${lvl}: ${msg}${extra}`)
  }
  const l = { level }
  for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) l[k] = emit(k)
  l.child = () => l
  return l
}
const silent = makeLogger('', 'silent')

let cached = null
async function loadBaileys() {
  if (cached) return cached
  let mod
  try {
    mod = await import('baileys')
  } catch {
    mod = await import('@whiskeysockets/baileys')
  }
  const d = mod.default
  const pick = (k) => mod[k] ?? d?.[k]
  cached = {
    makeWASocket: typeof d === 'function' ? d : pick('makeWASocket') ?? d?.default,
    useMultiFileAuthState: pick('useMultiFileAuthState'),
    DisconnectReason: pick('DisconnectReason') || {},
    downloadMediaMessage: pick('downloadMediaMessage'),
    fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion'),
    fetchLatestWaWebVersion: pick('fetchLatestWaWebVersion'),
    Browsers: pick('Browsers'),
  }
  return cached
}

// ------------------------------------------------------------------------
// WhatsApp Web version. WhatsApp rejects connections from client versions
// it considers too old (close code 405, *before* any QR is shown), and
// fetchLatestBaileysVersion() has been returning a stale version while
// claiming it's current. So: ask web.whatsapp.com directly, fall back to
// Baileys' list, never go backwards, and share one answer across sessions.
// WA_VERSION=2.3000.xxxxxxxxxx overrides everything if you ever need it.
// ------------------------------------------------------------------------
const VERSION_TTL = 6 * 3600 * 1000
let versionBest = null // [a, b, c]
let versionAt = 0
let versionInflight = null

const cmpVersion = (a, b) => {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0)
  return 0
}
const isVersion = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0)
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

export function forgetVersion() {
  versionAt = 0 // force a re-check next time, but keep versionBest as a floor
}

async function resolveVersion(B) {
  const manual = String(process.env.WA_VERSION || '').split('.').map(Number)
  if (isVersion(manual)) return manual
  if (versionBest && Date.now() - versionAt < VERSION_TTL) return versionBest
  if (versionInflight) return versionInflight
  versionInflight = (async () => {
    const found = []
    const attempt = async (src, fn) => {
      if (typeof fn !== 'function') return
      try {
        const r = await timeout(fn({ timeout: 10000 }), 12000)
        if (isVersion(r?.version)) found.push({ src, v: r.version })
      } catch {}
    }
    await Promise.all([
      attempt('web.whatsapp.com', B.fetchLatestWaWebVersion),
      attempt('baileys', B.fetchLatestBaileysVersion),
    ])
    if (versionBest) found.push({ src: 'previous', v: versionBest })
    found.sort((a, b) => cmpVersion(b.v, a.v))
    const pick = found[0]
    if (pick) {
      if (!versionBest || cmpVersion(pick.v, versionBest) !== 0) {
        console.log(`  using WhatsApp Web version ${pick.v.join('.')} (from ${pick.src})`)
      }
      versionBest = pick.v
      versionAt = Date.now()
    } else {
      console.log('  could not look up the WhatsApp Web version; using the one bundled with Baileys')
    }
    return versionBest || undefined
  })()
  try {
    return await versionInflight
  } finally {
    versionInflight = null
  }
}

// WA_BROWSER=chrome links as a plain web browser instead of the desktop app.
// Desktop is what gets full history, so it's the default.
// The platform we report has to agree with the identity, or WhatsApp hangs up
// during login (see patch-baileys.mjs). WA_PLATFORM=WEB|MACOS overrides.
function browserIdentity(B) {
  const chrome = (process.env.WA_BROWSER || '').toLowerCase() === 'chrome'
  globalThis.__WA_PLATFORM__ = (process.env.WA_PLATFORM || (chrome ? 'WEB' : 'MACOS')).toUpperCase()
  if (chrome) return B.Browsers?.ubuntu ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4']
  return B.Browsers?.macOS ? B.Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '14.4.1']
}

let patchState
function platformPatched() {
  if (patchState === undefined) {
    try {
      patchState = Number(fs.readFileSync(path.resolve('node_modules/baileys/.wa-platform-patch'), 'utf8')) > 0
    } catch {
      patchState = false
    }
  }
  return patchState
}

// Plain-language reasons for the codes WhatsApp closes connections with.
const REASONS = {
  405: 'WhatsApp refused this client version — fetching a newer one and retrying',
  408: 'The connection timed out',
  428: 'WhatsApp closed the connection',
  440: 'This WhatsApp session was opened by another copy of this server',
  403: 'WhatsApp refused this account (403)',
  500: "WhatsApp didn't accept the saved login",
  503: 'WhatsApp is temporarily unavailable',
}

// Buffers <-> JSON, so media keys survive in the JSON snapshot on disk.
const toJsonSafe = (obj) =>
  JSON.parse(
    JSON.stringify(obj, function (k, v) {
      const raw = this[k]
      if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return { $b: Buffer.from(raw).toString('base64') }
      if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
        return { $b: Buffer.from(v.data).toString('base64') }
      }
      if (raw && typeof raw === 'object' && typeof raw.toNumber === 'function' && 'low' in raw) {
        return raw.toNumber()
      }
      return v
    })
  )
const fromJsonSafe = (obj) =>
  JSON.parse(JSON.stringify(obj), (k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? Buffer.from(v.$b, 'base64') : v))

const safeJson = (v) => {
  try {
    return JSON.stringify(v).slice(0, 200)
  } catch {
    return String(v)
  }
}

const num = (t) => (t == null ? 0 : typeof t === 'object' && t.toNumber ? t.toNumber() : Number(t) || 0)

export class Session extends EventEmitter {
  constructor({ key, label, dir }) {
    super()
    this.setMaxListeners(0) // one listener per open browser tab
    this.key = key
    this.label = label
    this.dir = dir
    this.authDir = path.join(dir, 'auth')
    this.store = new Store(path.join(dir, 'store.json'))
    this.groupCache = new Map()
    this.lidTried = new Set()
    this.status = 'starting'
    this.qr = null
    this.me = null
    this.attempts = 0
    this.failures = 0 // consecutive failed connects, reset when we get online
    this.lastError = null
    this.registered = false
    this.gen = 0
    this.stopped = false
    fs.mkdirSync(this.authDir, { recursive: true })
  }

  log(...a) {
    console.log(`[${this.key}]`, ...a)
  }

  setStatus(status) {
    this.status = status
    this.emit('event', { type: 'status', ...this.info() })
  }

  info() {
    return {
      status: this.status,
      qr: this.qr,
      me: this.me,
      label: this.label,
      error: this.status === 'connected' ? null : this.lastError,
      failures: this.failures,
      linked: this.registered,
      sid: this.gen, // changes whenever a new connection starts (pairing codes die with it)
    }
  }

  viewers() {
    return this.listenerCount('event')
  }

  /** Someone opened the page: start an idle (never-linked) session. */
  wake() {
    this.wokeAt = Date.now()
    if (!this.stopped && this.status === 'idle') this.start(true).catch((e) => this.log('start failed:', e.message))
  }

  /** Someone is looking, or just opened the page and is still connecting. */
  watched() {
    return this.viewers() > 0 || Date.now() - (this.wokeAt || 0) < 30000
  }

  schedule(ms, force = false) {
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.start(force).catch((e) => this.log('start failed:', e.message)), ms)
  }

  // ------------------------------------------------------------ lifecycle
  async start(force = false) {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    const gen = ++this.gen
    // never leave an old socket running next to the new one
    try { this.sock?.end?.(undefined) } catch {}
    this.sock = null

    const B = await loadBaileys()
    const { state, saveCreds } = await B.useMultiFileAuthState(this.authDir)
    if (this.stopped || gen !== this.gen) return
    this.registered = !!state.creds?.registered

    // Not linked and nobody looking at the page: don't sit on WhatsApp's
    // servers generating QR codes for no one. Opening the page wakes it.
    if (!this.registered && !force && !this.watched()) {
      this.qr = null
      this.setStatus('idle')
      return
    }

    if (this.status !== 'reconnecting') this.setStatus('starting')
    const version = await resolveVersion(B)
    if (this.stopped || gen !== this.gen) return

    // While pairing, let Baileys explain itself in the logs; once linked,
    // only warnings. WA_LOG=info|debug|warn|silent overrides.
    const level = process.env.WA_LOG || (this.registered ? 'warn' : 'info')
    const browser = browserIdentity(B)
    const platform = platformPatched() ? globalThis.__WA_PLATFORM__ : 'WEB (build patch missing)'
    this.log(`connecting (${this.registered ? 'linked' : 'not linked yet'}, as ${browser.slice(0, 2).join(' ')}, platform ${platform})`)
    this.diag = { at: Date.now(), qr: false, ws: null, net: null }
    const sock = B.makeWASocket({
      auth: state,
      version,
      logger: makeLogger(`[${this.key}]`, level),
      // A desktop identity is what makes WhatsApp send the proper backlog.
      browser,
      syncFullHistory: FULL_HISTORY,
      // Accept every history type. Leaving this out while syncFullHistory is
      // false makes some 7.x builds reject *all* history, including recent.
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false, // keeps notifications on the phone working
      generateHighQualityLinkPreview: false,
      qrTimeout: 60_000, // each QR lives a minute: time to find your phone
      getMessage: async (key) => {
        const m = this.store.findMessage(key.remoteJid, key.id)
        return m?.text && m.type === 'text' ? { conversation: m.text } : undefined
      },
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    })
    this.sock = sock
    const live = () => gen === this.gen && !this.stopped
    const diag = this.diag

    // The raw socket knows *why* it closed; Baileys flattens that to "428".
    const ws = sock.ws
    if (ws?.on) {
      ws.on('close', (code, reason) => { diag.ws = { code, reason: reason ? String(reason).slice(0, 120) : '' } })
      ws.on('error', (e) => { diag.net = e?.code || e?.message || String(e) })
      ws.on('unexpected-response', (req, res) => { diag.net = `HTTP ${res?.statusCode} from WhatsApp during connect` })
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      if (!live()) return
      if (u.qr) {
        diag.qr = true
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 })
        if (!live()) return
        this.lastError = null
        this.setStatus('qr')
      }
      if (u.connection === 'open') {
        this.qr = null
        this.attempts = 0
        this.failures = 0
        this.lastError = null
        this.registered = true
        const uid = sock.user?.id
        const pn = uid ? bare(uid) : null
        if (sock.user?.lid && pn) this.store.link(sock.user.lid, pn)
        this.me = {
          jid: pn,
          phone: phoneOf(pn),
          name: sock.user?.name || sock.user?.verifiedName || sock.user?.notify || '',
        }
        this.setStatus('connected')
        this.log('connected as', this.me.phone || pn)
        this.loadGroups(sock)
        this.scheduleLidResolve()
      }
      if (u.connection === 'close') await this.onClose(B, u, sock)
    })

    // --- history: arrives in batches right after pairing (and on demand) ---
    sock.ev.on('messaging-history.set', (h) => {
      if (!live()) return
      const { chats = [], contacts = [], messages = [], syncType, progress } = h
      for (const m of h.lidPnMappings || h.lidMappings || []) this.store.link(m.lid, m.pn ?? m.phoneNumber)
      for (const c of contacts) this.onContact(c)
      for (const c of chats) this.onChat(c)
      let n = 0
      for (const m of messages) if (this.ingest(m, { bumpUnread: false })) n++
      this.log(
        `history batch: type=${syncType ?? '?'} chats=${chats.length} contacts=${contacts.length} messages=${n}` +
          (progress != null ? ` progress=${progress}%` : '')
      )
      this.emit('event', { type: 'history', chats: chats.length, messages: n, progress })
      this.emit('event', { type: 'chats' })
      this.scheduleLidResolve()
    })

    sock.ev.on('contacts.upsert', (cs) => {
      if (!live()) return
      for (const c of cs) this.onContact(c)
      this.emit('event', { type: 'chats' })
    })
    sock.ev.on('contacts.update', (cs) => {
      if (!live()) return
      for (const c of cs) this.onContact(c)
    })

    sock.ev.on('chats.upsert', (cs) => {
      if (!live()) return
      for (const c of cs) this.onChat(c)
      this.emit('event', { type: 'chats' })
    })
    sock.ev.on('chats.update', (cs) => {
      if (!live()) return
      for (const c of cs) this.onChat(c, true)
      this.emit('event', { type: 'chats' })
    })

    const onGroups = (gs) => {
      if (!live()) return
      for (const g of gs) {
        if (!g?.id) continue
        if (g.subject) this.store.setGroup(g.id, g.subject)
        if (g.participants) this.groupCache.set(g.id, { ...(this.groupCache.get(g.id) || {}), ...g })
      }
      this.emit('event', { type: 'chats' })
    }
    sock.ev.on('groups.upsert', onGroups)
    sock.ev.on('groups.update', onGroups)

    sock.ev.on('lid-mapping.update', (p) => {
      if (!live()) return
      const list = Array.isArray(p) ? p : p?.mappings || [p]
      let changed = false
      for (const m of list) changed = this.store.link(m?.lid, m?.pn ?? m?.phoneNumber) || changed
      if (changed) this.emit('event', { type: 'chats' })
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!live()) return
      for (const m of messages) {
        const msg = this.ingest(m, { bumpUnread: type === 'notify' })
        if (msg) this.emit('event', { type: 'message', message: this.publicMsg(msg) })
      }
      this.emit('event', { type: 'chats' })
    })
  }

  async onClose(B, u, sock) {
    const DR = B.DisconnectReason || {}
    const err = u.lastDisconnect?.error
    const code = err?.output?.statusCode
    const d = this.diag || {}
    const secs = d.at ? ((Date.now() - d.at) / 1000).toFixed(1) : '?'
    let text = REASONS[code] || `Disconnected (${code ?? err?.message ?? 'unknown'})`
    if (code === 428 && !d.qr && !this.registered) text += ' before sending a QR code'
    const detail = [
      `after ${secs}s`,
      d.qr ? 'QR had been shown' : this.registered ? null : 'no QR yet',
      d.ws ? `socket close ${d.ws.code}${d.ws.reason ? ' "' + d.ws.reason + '"' : ''}` : null,
      d.net ? `network: ${d.net}` : null,
      err?.message && err.message !== err?.output?.payload?.error ? `baileys: ${err.message}` : null,
      err?.data ? `data: ${safeJson(err.data)}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    this.lastError = { code: code ?? null, text, detail }
    this.qr = null

    if (code === (DR.loggedOut ?? 401)) {
      this.log('logged out from the phone: clearing credentials')
      await this.wipeAuth()
      this.me = null
      this.registered = false
      this.failures = 0
      this.lastError = { code, text: 'This device was unlinked. Scan a new QR code to link again.' }
      this.setStatus('logged-out')
      return this.schedule(1500)
    }
    if (code === (DR.restartRequired ?? 515)) {
      // normal right after scanning a QR: WhatsApp asks for a fresh connection
      this.lastError = null
      this.setStatus('reconnecting')
      return this.schedule(200, true)
    }

    this.failures++
    this.attempts++
    if (code === 405) forgetVersion()

    // A saved login WhatsApp won't take (or one that never finished pairing)
    // can't recover by retrying. Start over with a fresh QR.
    const unusable = code === (DR.badSession ?? 500) || code === (DR.multideviceMismatch ?? 411)
    if (unusable && this.failures >= 2) {
      this.log(`saved login rejected (${code}); clearing it so a new QR can be shown`)
      await this.wipeAuth()
      this.registered = false
      this.me = null
    }

    // Not linked and nobody watching: stop until someone opens the page.
    if (!this.registered && !this.watched()) {
      this.log(`connection closed (${code}) [${detail}]; idle until someone opens the page`)
      this.setStatus('idle')
      return
    }

    let wait = Math.min(60000, 1000 * 2 ** Math.min(this.attempts, 6))
    if (code === 440) wait = Math.max(wait, 30000) // let the other copy finish shutting down
    this.setStatus('reconnecting')
    this.log(`connection closed (${code}): ${text} [${detail}]; retry ${this.failures} in ${Math.round(wait / 1000)}s`)
    this.schedule(wait, true)
  }

  /** For people using this page on the same phone that has WhatsApp. */
  async pairingCode(phone) {
    if (this.status !== 'qr' || !this.sock?.requestPairingCode) {
      const e = new Error('Wait until the QR code is showing, then try again')
      e.status = 409
      throw e
    }
    const digits = String(phone || '').replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) {
      const e = new Error('Enter your full number with country code, e.g. 6591234567')
      e.status = 400
      throw e
    }
    const raw = await this.sock.requestPairingCode(digits)
    const code = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    this.log('pairing code issued')
    return { code: code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code, sid: this.gen }
  }

  // ---------------------------------------------------------- ingestion
  onContact(c) {
    if (!c?.id) return
    const ids = [c.id, c.lid, c.phoneNumber, c.jid].filter(Boolean)
    const lid = ids.find(isLid)
    const pn = ids.map(toPn).find(Boolean)
    if (lid && pn) this.linkAndNotify(lid, pn)
    this.store.setContact(pn || lid || c.id, {
      name: c.name,
      notify: c.notify,
      verified: c.verifiedName,
    })
  }

  onChat(c, isUpdate = false) {
    if (!c?.id) return
    for (const alt of [c.pnJid, c.lidJid, c.accountLid]) if (alt) this.linkAndNotify(c.id, alt)
    const jid = this.store.canon(c.id)
    if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return
    if (isGroup(jid)) {
      if (c.name || c.subject) this.store.setGroup(jid, c.name || c.subject)
    } else if (c.name || c.displayName) {
      this.store.setContact(jid, { name: c.name || c.displayName })
    }
    const patch = {}
    const t = num(c.conversationTimestamp || c.lastMessageRecvTimestamp)
    if (t) patch.t = t
    if (c.unreadCount != null) patch.unread = Math.max(0, c.unreadCount)
    if (!isUpdate || Object.keys(patch).length) this.store.touchChat(jid, patch)
  }

  linkAndNotify(a, b) {
    const before = this.store.canon(a)
    if (this.store.linkPair(a, b)) {
      const after = this.store.canon(a)
      if (before !== after) this.emit('event', { type: 'merged', from: before, to: after })
    }
  }

  /** Raw Baileys message -> our slim shape, stored under the canonical chat. */
  ingest(m, opts) {
    const k = m?.key
    const rj = k?.remoteJid
    if (!rj || rj.endsWith('@broadcast') || rj.endsWith('@newsletter')) return null

    // every alternate address WhatsApp hands us is a free LID->phone mapping
    this.linkAndNotify(rj, k.remoteJidAlt || k.senderPn || k.senderLid)
    if (k.participant) this.linkAndNotify(k.participant, k.participantAlt || k.participantPn || k.participantLid)

    const c = inner(m.message)
    if (!c) return null
    if (c.protocolMessage || c.senderKeyDistributionMessage || c.reactionMessage) {
      if (!c.conversation && !c.extendedTextMessage) return null
    }

    let type = 'text'
    let text = ''
    let mediaKey = null
    let fileName
    if (c.conversation) text = c.conversation
    else if (c.extendedTextMessage?.text) text = c.extendedTextMessage.text
    else if (c.imageMessage) { type = 'image'; text = c.imageMessage.caption || ''; mediaKey = 'imageMessage' }
    else if (c.videoMessage) { type = 'video'; text = c.videoMessage.caption || ''; mediaKey = 'videoMessage' }
    else if (c.audioMessage) { type = 'audio'; mediaKey = 'audioMessage' }
    else if (c.stickerMessage) { type = 'sticker'; mediaKey = 'stickerMessage' }
    else if (c.documentMessage) {
      type = 'document'
      fileName = c.documentMessage.fileName || 'Document'
      text = c.documentMessage.caption || ''
      mediaKey = 'documentMessage'
    } else if (c.locationMessage) {
      type = 'location'
      text = `${c.locationMessage.degreesLatitude}, ${c.locationMessage.degreesLongitude}`
    } else if (c.contactMessage) {
      type = 'contact'
      text = c.contactMessage.displayName || 'Contact'
    } else {
      return null
    }

    const jid = this.store.canon(rj)
    const group = isGroup(jid)
    const sender = k.participant ? this.store.canon(k.participant) : undefined
    if (m.pushName && !k.fromMe) this.store.setContact(group ? sender : jid, { notify: m.pushName })

    let rm
    if (mediaKey) {
      const sub = { ...c[mediaKey] }
      delete sub.jpegThumbnail // big, and we fetch the real thing on demand
      delete sub.contextInfo
      rm = toJsonSafe({
        key: { remoteJid: rj, id: k.id, fromMe: !!k.fromMe, participant: k.participant },
        message: { [mediaKey]: sub },
      })
    }

    const msg = {
      id: k.id,
      jid,
      fromMe: !!k.fromMe,
      ts: num(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      type,
      text,
      fileName,
      sender,
      rj: rj !== jid ? rj : undefined, // original address, needed for receipts
      rp: k.participant || undefined,
      rm,
    }
    return this.store.addMessage(msg, opts)
  }

  publicMsg(m) {
    return {
      id: m.id,
      jid: m.jid,
      fromMe: m.fromMe,
      ts: m.ts,
      type: m.type,
      text: m.text,
      media: !!m.rm,
      fileName: m.fileName,
      senderName: isGroup(m.jid) && !m.fromMe && m.sender ? this.store.displayName(m.sender) : '',
    }
  }

  async loadGroups(sock) {
    try {
      const all = await sock.groupFetchAllParticipating()
      for (const g of Object.values(all || {})) {
        this.groupCache.set(g.id, g)
        if (g.subject) this.store.setGroup(g.id, g.subject)
      }
      this.emit('event', { type: 'chats' })
    } catch (e) {
      this.log('could not list groups:', e.message)
    }
  }

  /** Ask Baileys' own LID store about chats we still only know by LID. */
  scheduleLidResolve() {
    clearTimeout(this.lidTimer)
    this.lidTimer = setTimeout(() => this.resolveLids().catch(() => {}), 3000)
  }

  async resolveLids() {
    const repo = this.sock?.signalRepository?.lidMapping
    if (!repo?.getPNForLID) return
    let changed = false
    for (const lid of this.store.pendingLids()) {
      if (this.lidTried.has(lid) || this.store.alias.has(lid)) continue
      this.lidTried.add(lid)
      try {
        const pn = await repo.getPNForLID(lid)
        if (pn) {
          const before = this.store.canon(lid)
          if (this.store.link(lid, pn)) {
            changed = true
            this.emit('event', { type: 'merged', from: before, to: this.store.canon(lid) })
          }
        }
      } catch {
        /* unknown to the local store; will resolve when a message carries it */
      }
    }
    if (changed) this.emit('event', { type: 'chats' })
  }

  // ------------------------------------------------------------- actions
  ensureConnected() {
    if (!this.sock || this.status !== 'connected') {
      const e = new Error('WhatsApp is not connected yet')
      e.status = 409
      throw e
    }
  }

  async send(jid, text) {
    this.ensureConnected()
    const sent = await this.sock.sendMessage(jid, { text })
    const msg = this.ingest(sent, { bumpUnread: false })
    if (msg) this.emit('event', { type: 'message', message: this.publicMsg(msg) })
    this.emit('event', { type: 'chats' })
    return msg ? this.publicMsg(msg) : null
  }

  async sendMedia(jid, buffer, { mime, name, caption, thumb }) {
    this.ensureConnected()
    let content
    if (mime === 'image/jpeg') {
      content = { image: buffer, mimetype: 'image/jpeg', caption: caption || undefined }
      // A client-made thumbnail means we don't need sharp/jimp on the server.
      if (thumb) content.jpegThumbnail = thumb
    } else {
      content = {
        document: buffer,
        mimetype: mime || 'application/octet-stream',
        fileName: name || 'file',
        caption: caption || undefined,
      }
    }
    const sent = await this.sock.sendMessage(jid, content)
    const msg = this.ingest(sent, { bumpUnread: false })
    if (msg) this.emit('event', { type: 'message', message: this.publicMsg(msg) })
    this.emit('event', { type: 'chats' })
    return msg ? this.publicMsg(msg) : null
  }

  /** Validate a phone number against WhatsApp and return its chat JID. */
  async resolveNumber(input) {
    this.ensureConnected()
    const digits = String(input || '').replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) {
      const e = new Error('Enter the full number with country code, e.g. 6591234567')
      e.status = 400
      throw e
    }
    let jid = `${digits}@s.whatsapp.net`
    if (typeof this.sock.onWhatsApp === 'function') {
      const [r] = (await this.sock.onWhatsApp(digits)) || []
      if (!r?.exists) {
        const e = new Error(`+${digits} is not on WhatsApp`)
        e.status = 404
        throw e
      }
      jid = bare(r.jid) || jid
      if (r.lid) this.store.link(r.lid, jid)
    }
    return { jid: this.store.canon(jid), name: this.store.displayName(jid), phone: phoneOf(jid) }
  }

  /** Ask the phone for older messages in a chat. They arrive via history.set. */
  async fetchOlder(jid, count = 50) {
    this.ensureConnected()
    const oldest = this.store.oldest(jid)
    if (!oldest) return { requested: false, reason: 'no messages to page back from' }
    if (typeof this.sock.fetchMessageHistory !== 'function') {
      return { requested: false, reason: 'not supported by this Baileys version' }
    }
    this.store.raiseCap(jid, count + 10)
    await this.sock.fetchMessageHistory(
      count,
      { remoteJid: oldest.rj || jid, id: oldest.id, fromMe: oldest.fromMe, participant: oldest.rp },
      oldest.ts
    )
    return { requested: true }
  }

  async markRead(jid) {
    const had = this.store.chats.get(jid)?.unread
    this.store.markRead(jid)
    if (had) this.emit('event', { type: 'chats' })
    try {
      const last = [...(this.store.messages.get(jid) || [])].reverse().find((m) => !m.fromMe)
      if (last && this.sock && this.status === 'connected') {
        await this.sock.readMessages([{ remoteJid: last.rj || jid, id: last.id, participant: last.rp }])
      }
    } catch {
      /* receipts are best effort */
    }
  }

  async media(jid, id) {
    const m = this.store.findMessage(jid, id)
    if (!m?.rm) return null
    const B = await loadBaileys()
    const raw = fromJsonSafe(m.rm)
    const buffer = await B.downloadMediaMessage(raw, 'buffer', {}, {
      logger: silent,
      reuploadRequest: this.sock?.updateMediaMessage,
    })
    const sub = Object.values(raw.message)[0] || {}
    return { buffer, mime: sub.mimetype || 'application/octet-stream', fileName: sub.fileName }
  }

  async wipeAuth() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true })
      fs.mkdirSync(this.authDir, { recursive: true })
    } catch (e) {
      console.error('wipeAuth:', e.message)
    }
  }

  /** Unlink from the phone and show a fresh QR. Chat snapshot is kept. */
  async relink() {
    const sock = this.sock
    this.gen++ // ignore whatever the old socket does from here on
    clearTimeout(this.retryTimer)
    try { await timeout(sock?.logout?.() ?? Promise.resolve(), 5000) } catch {}
    try { sock?.end?.(undefined) } catch {}
    this.sock = null
    await this.wipeAuth()
    this.me = null
    this.qr = null
    this.registered = false
    this.failures = 0
    this.attempts = 0
    this.lastError = null
    this.setStatus('logged-out')
    this.schedule(500) // shows a QR if someone is on the page, otherwise idles
  }

  /** Permanently remove: unlink from the phone and delete everything. */
  async destroy() {
    this.stopped = true
    this.gen++
    clearTimeout(this.lidTimer)
    clearTimeout(this.retryTimer)
    try { await timeout(this.sock?.logout?.() ?? Promise.resolve(), 5000) } catch {}
    try { this.sock?.end?.(undefined) } catch {}
    this.store.close()
    fs.rmSync(this.dir, { recursive: true, force: true })
    this.removeAllListeners()
  }

  shutdown() {
    clearTimeout(this.retryTimer)
    this.store.close()
  }
}

function inner(message) {
  let m = message
  for (let i = 0; i < 4 && m; i++) {
    const next =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message
    if (!next) break
    m = next
  }
  return m
}
