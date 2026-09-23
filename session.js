import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { Store, historyCutoff, bare, isGroup, isLid, isPn, phoneOf, toPn } from './store.js'

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const mediaAttemptsEnv = Number(process.env.MEDIA_DOWNLOAD_ATTEMPTS || 3)
const MEDIA_DOWNLOAD_ATTEMPTS = Number.isFinite(mediaAttemptsEnv) && mediaAttemptsEnv > 0 ? Math.floor(mediaAttemptsEnv) : 3

// Baileys WebMessageInfo.Status values: ERROR=0, PENDING=1, SERVER_ACK=2,
// DELIVERY_ACK=3, READ=4, PLAYED=5. Keep only the monotonic delivery/read
// state we need for the WhatsApp-style ticks in the UI.
function messageStatusValue(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : null
}

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

// WhatsApp currently rejects Baileys desktop sub-platforms (DARWIN/WIN32)
// during the pre-QR registration handshake with close code 428. The canonical
// web-browser identity advertises WEB_BROWSER and still supports full history
// syncing with syncFullHistory=true, so use that for pairing.
//
// Keep this identity stable across reconnects: changing the advertised client
// between attempts can invalidate the handshake/session on WhatsApp's side.
function browserIdentity(B) {
  return B.Browsers?.ubuntu ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4']
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
    this.presence = new Map() // chat jid -> { lastKnownPresence, lastSeen, at }
    this.metrics = { messagesIn: 0, messagesOut: 0, reactionsIn: 0, reactionsOut: 0, lastInboundAt: 0, lastOutboundAt: 0, lastPresenceAt: 0, lastEventAt: Date.now(), lastMediaError: null, historyProgress: null }
    this.stopped = false
    fs.mkdirSync(this.authDir, { recursive: true })
  }

  log(...a) {
    console.log(`[${this.key}]`, ...a)
  }

  setStatus(status) {
    this.status = status
    this.metrics.lastEventAt = Date.now()
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

  health() {
    let storeBytes = 0
    try { storeBytes = fs.statSync(this.store.file).size } catch {}
    const mem = process.memoryUsage()
    const ws = this.diag?.ws || null
    return {
      key: this.key,
      label: this.label,
      status: this.status,
      linked: this.registered,
      failures: this.failures,
      error: this.status === 'connected' ? null : this.lastError,
      me: this.me,
      viewers: this.viewers(),
      generation: this.gen,
      sessionStartedAt: this.diag?.at || null,
      socket: {
        active: !!this.sock && this.status !== 'idle' && this.status !== 'logged-out',
        lastClose: ws,
        lastNetworkError: this.diag?.net || null,
      },
      metrics: { ...this.metrics },
      presence: this.presence.size,
      store: {
        bytes: storeBytes,
        chats: this.store.chats.size,
        messages: [...this.store.messages.values()].reduce((n, rows) => n + rows.length, 0),
        dirty: !!this.store.dirty,
      },
      runtime: {
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
    }
  }

  publicPresence(jid) {
    jid = this.store.canon(jid)
    const p = this.presence.get(jid)
    if (!p) return { jid, state: 'unknown', online: false, typing: false, lastSeen: null, at: null }
    const typing = p.lastKnownPresence === 'composing' || p.lastKnownPresence === 'recording'
    const online = typing || p.lastKnownPresence === 'available'
    return { jid, state: p.lastKnownPresence || 'unknown', online, typing, recording: p.lastKnownPresence === 'recording', lastSeen: p.lastSeen || null, at: p.at || null }
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
    this.log(`connecting (${this.registered ? 'linked' : 'not linked yet'}, as ${browser.slice(0, 2).join(' ')} / WEB_BROWSER)`)
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
        if (m?.rm) return fromJsonSafe(m.rm).message
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
      if (u.connection === 'close') {
        try {
          await this.onClose(B, u, sock)
        } catch (e) {
          if (live()) this.log('connection close handler failed:', e?.message || e)
        }
      }
    })

    // --- history: arrives in batches right after pairing (and on demand) ---
    sock.ev.on('messaging-history.set', (h) => {
      if (!live()) return
      try {
        const { chats = [], contacts = [], messages = [], syncType, progress } = h
        for (const m of h.lidPnMappings || h.lidMappings || []) {
          try {
            this.store.link(m.lid, m.pn ?? m.phoneNumber)
          } catch (e) {
            this.log('history LID mapping failed:', e?.message || e)
          }
        }
        for (const c of contacts) {
          try { this.onContact(c) } catch (e) { this.log('history contact failed:', e?.message || e) }
        }
        for (const c of chats) {
          try { this.onChat(c) } catch (e) { this.log('history chat failed:', e?.message || e) }
        }
        let n = 0
        let failed = 0
        for (const m of messages) {
          try {
            if (this.ingest(m, { bumpUnread: false })) n++
          } catch (e) {
            failed++
            this.log('history message failed:', m?.key?.id || '?', e?.message || e)
          }
        }
        this.log(
          `history batch: type=${syncType ?? '?'} chats=${chats.length} contacts=${contacts.length} messages=${n}` +
            (failed ? ` failed=${failed}` : '') +
            (progress != null ? ` progress=${progress}%` : '')
        )
        this.metrics.historyProgress = progress == null ? this.metrics.historyProgress : Number(progress)
        this.metrics.lastEventAt = Date.now()
        this.emit('event', { type: 'history', chats: chats.length, messages: n, progress })
        this.emit('event', { type: 'chats' })
        this.scheduleLidResolve()
      } catch (e) {
        this.log('history batch failed:', e?.message || e)
      }
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

    // Contact/group online state and typing. Baileys sends these through
    // presence.update after we subscribe to a chat's presence feed.
    sock.ev.on('presence.update', ({ id, presences = {} } = {}) => {
      if (!live() || !id) return
      const group = isGroup(this.store.canon(id))
      for (const [participant, raw] of Object.entries(presences)) {
        const chatJid = this.store.canon(id)
        const participantJid = this.store.canon(participant || id)
        const state = {
          lastKnownPresence: raw?.lastKnownPresence || 'unknown',
          lastSeen: raw?.lastSeen ? Number(raw.lastSeen) : null,
          at: Date.now(),
        }
        this.presence.set(group ? participantJid : chatJid, state)
        this.metrics.lastPresenceAt = state.at
        this.metrics.lastEventAt = state.at
        this.emit('event', {
          type: 'presence',
          jid: chatJid,
          participant: participantJid,
          ...state,
        })
      }
    })

    // Dedicated reaction events are emitted by Baileys for reactionMessage
    // updates. Keep support for history/upsert too via applyReaction().
    sock.ev.on('messages.reaction', (updates = []) => {
      if (!live()) return
      for (const entry of updates) {
        try { this.applyReactionEvent(entry) } catch (e) { this.log('reaction event failed:', e?.message || e) }
      }
    })

    sock.ev.on('messages.upsert', ({ messages = [], type }) => {
      if (!live()) return
      let received = 0
      let failed = 0
      let placeholders = 0
      for (const m of messages) {
        try {
          // Baileys can emit a placeholder when a message could not be
          // decrypted yet. Ask the phone to resend it instead of silently
          // dropping it from our local message list.
          if (!m?.message && !m?.messageStubType && m?.key?.id && typeof sock.requestPlaceholderResend === 'function') {
            this.rememberName(m)
            placeholders++
            Promise.resolve(sock.requestPlaceholderResend(m.key)).catch((e) => {
              if (live()) this.log('placeholder resend failed:', m.key.id, e?.message || e)
            })
            continue
          }

          const msg = this.ingest(m, { bumpUnread: type === 'notify' })
          if (msg) {
            received++
            this.metrics.messagesIn++
            this.metrics.lastInboundAt = Date.now()
            this.metrics.lastEventAt = Date.now()
            try {
              this.emit('event', { type: 'message', message: this.publicMsg(msg) })
            } catch (e) {
              this.log('message event delivery failed:', e?.message || e)
            }
          }
        } catch (e) {
          failed++
          this.log('incoming message failed:', m?.key?.id || '?', e?.message || e)
        }
      }
      if (received || failed || placeholders) {
        this.log(
          `messages.upsert type=${type ?? '?'} received=${received}` +
            (placeholders ? ` placeholders=${placeholders}` : '') +
            (failed ? ` failed=${failed}` : '')
        )
      }
      try { this.emit('event', { type: 'chats' }) } catch (e) { this.log('chat event delivery failed:', e?.message || e) }
    })

    // WhatsApp delivery/read receipts for messages we sent. In 1:1 chats,
    // Baileys emits these as messages.update status changes.
    sock.ev.on('messages.update', (updates = []) => {
      if (!live()) return
      for (const entry of updates) {
        try {
          const up = entry?.update || {}
          if (entry?.key?.id && (up.messageStubType === 1 || up.messageStubType === 'REVOKE')) {
            this.applyRemoteDelete(entry.key, entry.key)
            continue
          }
          const um = up.message
          if (entry?.key?.id && um && (um.editedMessage || um.protocolMessage?.type === 14 || um.protocolMessage?.type === 'MESSAGE_EDIT')) {
            const inn = inner(um)
            const edited = inn?.protocolMessage?.editedMessage || inn
            this.applyRemoteEdit(entry.key, entry.key, edited)
            continue
          }
          const id = entry?.key?.id
          const status = messageStatusValue(entry?.update?.status)
          if (!id || status == null) continue
          // Only our own messages need outgoing tick state.
          const rj = entry.key.remoteJid
          const jid = rj ? this.store.canon(rj) : null
          // In groups one person's receipt must not tick the whole message;
          // per-member receipts (below) decide delivered/read there.
          if (jid && isGroup(jid) && status >= 3) continue
          const existing = jid ? this.store.findMessage(jid, id) : null
          if (!existing?.fromMe) continue
          const next = Math.max(messageStatusValue(existing.status) ?? 2, status)
          if (next === (messageStatusValue(existing.status) ?? 2)) continue
          existing.status = next
          this.store.dirty = true
          this.emit('event', { type: 'message-status', jid, id, status: next })
        } catch (e) {
          this.log('message status update failed:', e?.message || e)
        }
      }
    })

    // Group chats use per-recipient receipt updates. Keep the highest receipt
    // state we have seen so the sender still gets useful ticks in the UI.
    sock.ev.on('message-receipt.update', (updates = []) => {
      if (!live()) return
      for (const entry of updates) {
        try {
          const id = entry?.key?.id
          const receipt = entry?.receipt || {}
          if (!id) continue
          const rj = entry?.key?.remoteJid
          const jid = rj ? this.store.canon(rj) : null
          const existing = jid ? this.store.findMessage(jid, id) : null
          if (!existing?.fromMe) continue
          let status = null
          if (receipt.readTimestamp || receipt.readTimestampMs || receipt.playedTimestamp) status = 4
          else if (receipt.receiptTimestamp || receipt.receiptTimestampMs) status = 3
          if (status == null) continue
          if (isGroup(jid)) {
            const who = receipt.userJid || entry?.key?.participant
            if (who) this.recordGroupReceipt(jid, existing, who, status)
            continue
          }
          const next = Math.max(messageStatusValue(existing.status) ?? 2, status)
          if (next === (messageStatusValue(existing.status) ?? 2)) continue
          existing.status = next
          this.store.dirty = true
          this.emit('event', { type: 'message-status', jid, id, status: next })
        } catch (e) {
          this.log('message receipt update failed:', e?.message || e)
        }
      }
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

    // Grab the sender's WhatsApp name before anything below can skip this
    // message (reactions, unsupported types, old history all carry it too).
    this.rememberName(m)

    const c = inner(m.message)
    if (!c) return null
    if (num(m.messageTimestamp) && num(m.messageTimestamp) < historyCutoff()) return null // outside the history window
    if (c.reactionMessage) {
      this.applyReactionEvent({
        key: c.reactionMessage.key || k,
        reaction: c.reactionMessage,
        reactorKey: k,
      })
      return null
    }
    const pm = c.protocolMessage
    if (pm?.key?.id) {
      const t = pm.type
      if (t === 0 || t === 'REVOKE') { this.applyRemoteDelete(pm.key, k); return null }
      if (t === 14 || t === 'MESSAGE_EDIT') { this.applyRemoteEdit(pm.key, k, pm.editedMessage); return null }
    }
    if (c.protocolMessage || c.senderKeyDistributionMessage) {
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

    // what this message is replying to, if anything
    const ctx = Object.values(c).find((v) => v && typeof v === 'object' && v.contextInfo?.stanzaId)?.contextInfo
    let quote
    if (ctx?.stanzaId) {
      const q = inner(ctx.quotedMessage) || {}
      const qText =
        q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption ||
        (q.imageMessage ? '📷 Photo' : q.videoMessage ? '🎥 Video' : q.audioMessage ? '🎤 Voice message' :
         q.documentMessage ? '📄 ' + (q.documentMessage.fileName || 'Document') : q.stickerMessage ? 'Sticker' : '')
      const qSender = ctx.participant ? this.store.canon(ctx.participant) : null
      quote = {
        id: ctx.stanzaId,
        text: String(qText).slice(0, 300),
        sender: qSender || undefined,
        fromMe: !!(qSender && this.me?.jid && qSender === this.store.canon(this.me.jid)),
      }
    }

    // who this message @mentions (text holds "@<number>", WhatsApp lists the people)
    const mctx = Object.values(c).find((v) => v && typeof v === 'object' && v.contextInfo?.mentionedJid?.length)?.contextInfo
    const mentions = (mctx?.mentionedJid || []).slice(0, 50).map((j) => ({ t: String(j).split('@')[0].split(':')[0], j: this.store.canon(j) }))

    const msg = {
      mentions: mentions.length ? mentions : undefined,
      quote,
      id: k.id,
      jid,
      fromMe: !!k.fromMe,
      // Outgoing messages start as sent/pending until WhatsApp sends a receipt.
      status: k.fromMe ? (messageStatusValue(m.status) ?? 2) : undefined,
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

  /** Save the sender's WhatsApp profile name (and business name) if present. */
  rememberName(m) {
    const k = m?.key
    if (!k?.remoteJid || k.fromMe) return
    const who = isGroup(this.store.canon(k.remoteJid)) ? k.participant : k.remoteJid
    if (!who) return
    const info = {}
    if (m.pushName && m.pushName.trim()) info.notify = m.pushName.trim()
    if (m.verifiedBizName) info.verified = m.verifiedBizName
    if (!info.notify && !info.verified) {
      this.noteMissingName(who)
      return
    }
    const had = this.store.profileName(who)
    this.store.setContact(who, info)
    if (!had && info.notify) this.log(`WhatsApp name for ${phoneOf(this.store.canon(who)) || this.store.canon(who)}: ${info.notify}`)
  }

  /** Log once per contact when their messages arrive without a WhatsApp name. */
  noteMissingName(who) {
    const jid = this.store.canon(who)
    this.nameless ??= new Set()
    if (this.nameless.has(jid) || this.store.profileName(jid) || this.nameless.size > 500) return
    this.nameless.add(jid)
    this.log(`no WhatsApp name included in messages from ${phoneOf(jid) || jid}`)
  }

  // ---------------------------------------------------- delete & edit
  applyRemoteDelete(targetKey, envelopeKey) {
    const jid = this.store.canon(targetKey.remoteJid || envelopeKey?.remoteJid || '')
    if (!jid) return
    const m = this.store.markDeleted(jid, targetKey.id)
    if (m) {
      this.emit('event', { type: 'message', message: this.publicMsg(m) })
      this.emit('event', { type: 'chats' })
    }
  }

  applyRemoteEdit(targetKey, envelopeKey, content) {
    const jid = this.store.canon(targetKey.remoteJid || envelopeKey?.remoteJid || '')
    const text = textOf(inner(content) || content)
    if (!jid || text == null) return
    const m = this.store.markEdited(jid, targetKey.id, text)
    if (m) {
      this.emit('event', { type: 'message', message: this.publicMsg(m) })
      this.emit('event', { type: 'chats' })
    }
  }

  keyFor(m, fallbackJid) {
    return { remoteJid: m.rj || fallbackJid, id: m.id, fromMe: !!m.fromMe, participant: m.rp || undefined }
  }

  /** Delete for everyone (your own messages, ~2.5 days) or just for you. */
  async deleteMessage(jid, id, everyone) {
    jid = this.store.canon(jid)
    const m = this.store.findMessage(jid, id)
    if (!m) throw Object.assign(new Error('Message not found'), { status: 404 })
    if (everyone) {
      if (!m.fromMe) throw Object.assign(new Error('You can only delete your own messages for everyone'), { status: 403 })
      if (m.deleted) return this.publicMsg(m)
      if (Date.now() / 1000 - m.ts > 60 * 3600) {
        throw Object.assign(new Error('Too old to delete for everyone. WhatsApp only allows it for about 2½ days.'), { status: 400 })
      }
      this.ensureConnected()
      const target = await this.sendJid(jid)
      await this.sock.sendMessage(target, { delete: this.keyFor(m, target) })
      const u = this.store.markDeleted(jid, id)
      this.emit('event', { type: 'message', message: this.publicMsg(u) })
      this.emit('event', { type: 'chats' })
      return this.publicMsg(u)
    }
    // for me: also remove it from your phone, like WhatsApp Web does
    let synced = false
    try {
      if (this.sock?.chatModify && this.status === 'connected') {
        const key = this.keyFor(m, jid)
        await this.sock.chatModify({ deleteForMe: { deleteMedia: false, key, timestamp: m.ts } }, key.remoteJid)
        synced = true
      }
    } catch (e) {
      this.log('delete-for-me sync failed (removed on this site only):', e?.message || e)
    }
    this.store.removeMessage(jid, id)
    this.emit('event', { type: 'message-removed', jid, id })
    this.emit('event', { type: 'chats' })
    return { removed: true, synced }
  }

  /** Edit your own text message (WhatsApp allows 15 minutes). */
  async editMessage(jid, id, text) {
    jid = this.store.canon(jid)
    text = String(text || '').trim()
    const m = this.store.findMessage(jid, id)
    if (!m) throw Object.assign(new Error('Message not found'), { status: 404 })
    if (!m.fromMe) throw Object.assign(new Error('You can only edit your own messages'), { status: 403 })
    if (m.deleted) throw Object.assign(new Error('That message was deleted'), { status: 400 })
    if (m.type !== 'text') throw Object.assign(new Error('Only text messages can be edited'), { status: 400 })
    if (!text) throw Object.assign(new Error('The message cannot be empty'), { status: 400 })
    if (text.length > 65000) throw Object.assign(new Error('Message too long'), { status: 400 })
    if (Date.now() / 1000 - m.ts > 15 * 60) {
      throw Object.assign(new Error('WhatsApp only lets you edit a message within 15 minutes of sending it'), { status: 400 })
    }
    if (text === m.text) return this.publicMsg(m)
    this.ensureConnected()
    const target = await this.sendJid(jid)
    await this.sock.sendMessage(target, { text, edit: this.keyFor(m, target) })
    const u = this.store.markEdited(jid, id, text)
    this.emit('event', { type: 'message', message: this.publicMsg(u) })
    this.emit('event', { type: 'chats' })
    return this.publicMsg(u)
  }

  publicMsg(m) {
    return {
      id: m.id,
      jid: m.jid,
      fromMe: m.fromMe,
      status: m.fromMe ? (messageStatusValue(m.status) ?? 2) : undefined,
      rsum: m.fromMe && m.rsum ? m.rsum : undefined,
      ts: m.ts,
      type: m.type,
      text: m.text,
      media: !!m.rm,
      fileName: m.fileName,
      quote: this.store.quoteView(m.quote),
      deleted: !!m.deleted,
      edited: !!m.edited,
      senderName: isGroup(m.jid) && !m.fromMe && m.sender ? this.store.displayName(m.sender) : '',
      reactions: this.store.reactionView(m, this.me?.jid),
      mentions: this.store.mentionView(m, this.me?.jid),
    }
  }

  applyReactionEvent(entry = {}) {
    const targetKey = entry?.key || entry?.reaction?.key || {}
    const reaction = entry?.reaction || {}
    const reactorKey = entry?.reactorKey || reaction?.key || {}
    const targetId = targetKey?.id
    const rawJid = targetKey?.remoteJid
    if (!targetId || !rawJid) return null
    const jid = this.store.canon(rawJid)
    if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null
    const reactorRaw = reactorKey?.fromMe ? this.me?.jid || reactorKey?.remoteJid : (isGroup(jid) ? reactorKey?.participant || reactorKey?.participantAlt : reactorKey?.remoteJid)
    const reactor = reactorRaw ? this.store.canon(reactorRaw) : null
    if (!reactor) return null
    const m = this.store.setReaction(jid, targetId, reactor, reaction?.text || '')
    if (!m) return null
    this.metrics.reactionsIn++
    this.metrics.lastInboundAt = Date.now()
    this.metrics.lastEventAt = Date.now()
    const payload = { type: 'reaction', jid, id: targetId, reactions: this.store.reactionView(m, this.me?.jid) }
    this.emit('event', payload)
    return payload
  }

  async presenceSubscribe(jid) {
    this.ensureConnected()
    jid = this.store.canon(jid)
    const target = await this.sendJid(jid)
    try {
      if (typeof this.sock.presenceSubscribe === 'function') await this.sock.presenceSubscribe(target)
    } catch (e) { this.log('presence subscribe failed:', e?.message || e) }
    return this.publicPresence(jid)
  }

  async typing(jid, state) {
    this.ensureConnected()
    jid = this.store.canon(jid)
    const target = await this.sendJid(jid)
    const next = ['composing', 'recording', 'paused'].includes(state) ? state : 'paused'
    if (typeof this.sock.sendPresenceUpdate === 'function') await this.sock.sendPresenceUpdate(next, target)
    return { ok: true, state: next }
  }

  async react(jid, messageId, emoji) {
    this.ensureConnected()
    jid = this.store.canon(jid)
    const target = await this.sendJid(jid)
    const m = this.store.findMessage(jid, messageId)
    if (!m) { const e = new Error('Message not found'); e.status = 404; throw e }
    const key = { remoteJid: m.rj || jid, id: m.id, fromMe: !!m.fromMe, participant: m.rp }
    await this.sock.sendMessage(target, { react: { text: emoji || '', key } })
    const mine = this.me?.jid || this.store.canon(this.sock.user?.id || '')
    const updated = this.store.setReaction(jid, messageId, this.store.canon(mine), emoji || '')
    this.metrics.reactionsOut++
    this.metrics.lastOutboundAt = Date.now()
    this.metrics.lastEventAt = Date.now()
    if (updated) this.emit('event', { type: 'reaction', jid, id: messageId, reactions: this.store.reactionView(updated, this.me?.jid) })
    return { id: messageId, reactions: updated ? this.store.reactionView(updated, this.me?.jid) : [] }
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

  // WhatsApp is migrating personal contacts from PN JIDs (@s.whatsapp.net)
  // to LID JIDs (@lid). Baileys rc14 can still enter assertSessions with the
  // PN address and WhatsApp may answer 406/not-acceptable. Resolve a PN to its
  // LID immediately before sending so the encryption-session lookup uses the
  // address WhatsApp expects. Groups are left untouched.
  async sendJid(jid) {
    const target = this.store.canon(jid)
    if (!isPn(target) || isGroup(target)) return target

    const mapping = this.sock?.signalRepository?.lidMapping
    try {
      if (mapping?.getLIDsForPNs) {
        const rows = await mapping.getLIDsForPNs([target])
        const lid = Array.isArray(rows) ? rows.find((x) => x?.pn === target)?.lid || rows.find((x) => x?.lid)?.lid : null
        if (lid) {
          this.store.link(lid, target)
          this.log(`resolved send target ${target} -> ${lid}`)
          return lid
        }
      }
    } catch (e) {
      this.log(`send target LID lookup failed for ${target}: ${e?.message || e}`)
    }

    // The local store may already know the LID from an incoming/history event
    // even when Baileys' live mapping cache does not. Use that as a fallback.
    for (const [lid, pn] of this.store.alias) {
      if (pn === target && isLid(lid)) {
        this.log(`using stored send target ${target} -> ${lid}`)
        return lid
      }
    }
    return target
  }

  /** Rebuild a stored message into the shape Baileys needs for `quoted`. */
  quotedFor(jid, replyTo) {
    const m = replyTo && this.store.findMessage(jid, replyTo)
    if (!m) return undefined
    const key = { remoteJid: m.rj || m.jid, id: m.id, fromMe: m.fromMe, participant: m.rp }
    const message = m.rm ? fromJsonSafe(m.rm).message : { conversation: m.text || '' }
    return { key, message }
  }

  async send(jid, text, replyTo, mentions) {
    this.ensureConnected()
    const target = await this.sendJid(jid)
    const quoted = this.quotedFor(jid, replyTo)
    const content = { text }
    const ms = [...new Set((Array.isArray(mentions) ? mentions : []).map(String))]
      .filter((j) => /^\d+(:\d+)?@(s\.whatsapp\.net|lid)$/.test(j) && text.includes('@' + j.split('@')[0].split(':')[0]))
      .slice(0, 50)
    if (ms.length) content.mentions = ms
    const sent = await this.sock.sendMessage(target, content, quoted ? { quoted } : undefined)
    const msg = this.ingest(sent, { bumpUnread: false })
    this.metrics.messagesOut++
    this.metrics.lastOutboundAt = Date.now()
    this.metrics.lastEventAt = Date.now()
    if (msg) this.emit('event', { type: 'message', message: this.publicMsg(msg) })
    this.emit('event', { type: 'chats' })
    return msg ? this.publicMsg(msg) : null
  }

  async sendMedia(jid, buffer, { mime, name, caption, thumb, replyTo }) {
    this.ensureConnected()
    const target = await this.sendJid(jid)
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
    const quoted = this.quotedFor(jid, replyTo)
    const sent = await this.sock.sendMessage(target, content, quoted ? { quoted } : undefined)
    const msg = this.ingest(sent, { bumpUnread: false })
    this.metrics.messagesOut++
    this.metrics.lastOutboundAt = Date.now()
    this.metrics.lastEventAt = Date.now()
    if (msg) this.emit('event', { type: 'message', message: this.publicMsg(msg) })
    this.emit('event', { type: 'chats' })
    return msg ? this.publicMsg(msg) : null
  }

  /** Validate a phone number against WhatsApp and return its chat JID. */
  // ------------------------------------------------ group read receipts
  // WhatsApp: ✓✓ once EVERY member has received it, blue once EVERY member read it.
  recordGroupReceipt(jid, msg, who, status) {
    const p = this.store.canon(who)
    if (!p || p === this.store.canon(this.me?.jid || '')) return
    msg.rcpt ??= {}
    if ((msg.rcpt[p] || 0) >= status) return
    msg.rcpt[p] = status
    this.store.dirty = true
    this.updateGroupTick(jid, msg)
  }

  groupRecipients(jid) {
    const md = this.groupCache.get(jid)
    if (!md?.participants) return null
    const me = this.store.canon(this.me?.jid || '')
    const set = new Set()
    for (const p of md.participants) {
      const ids = [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean)
      const lid = ids.find(isLid), pn = ids.map(toPn).find(Boolean)
      if (lid && pn) this.store.link(lid, pn)
      const c = this.store.canon(pn || p.id)
      if (c !== me) set.add(c)
    }
    return set
  }

  updateGroupTick(jid, msg) {
    const members = this.groupRecipients(jid)
    if (!members) {
      // don't know who's in the group yet: fetch once, then recount
      if (!this.gmFetching?.has(jid) && this.sock?.groupMetadata) {
        (this.gmFetching ??= new Set()).add(jid)
        this.sock.groupMetadata(jid)
          .then((md) => { this.groupCache.set(jid, md); this.updateGroupTick(jid, msg) })
          .catch(() => {})
          .finally(() => this.gmFetching.delete(jid))
      }
      return
    }
    const total = members.size
    let delivered = 0, read = 0
    for (const m of members) {
      const r = msg.rcpt?.[this.store.canon(m)] || 0
      if (r >= 3) delivered++
      if (r >= 4) read++
    }
    msg.rsum = { total, delivered, read }
    const status = total && read >= total ? 4 : total && delivered >= total ? 3 : 2
    // always tell the page, so the "Read by x of y" counts stay current
    msg.status = status
    this.store.dirty = true
    this.emit('event', { type: 'message-status', jid, id: msg.id, status, rsum: msg.rsum })
  }

  // --------------------------------------------------------- group members
  async groupMembers(jid) {
    this.ensureConnected()
    jid = this.store.canon(jid)
    if (!isGroup(jid)) throw Object.assign(new Error('Not a group'), { status: 400 })
    const md = await this.sock.groupMetadata(jid)
    this.groupCache.set(jid, md)
    if (md.subject) this.store.setGroup(jid, md.subject)
    const meJid = this.store.canon(this.me?.jid || '')
    const members = (md.participants || []).map((p) => {
      const ids = [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean)
      const lid = ids.find(isLid)
      const pn = ids.map(toPn).find(Boolean)
      if (lid && pn) this.store.link(lid, pn)
      const c = this.store.canon(pn || p.id)
      return { id: p.id, jid: c, name: this.store.displayName(c), phone: phoneOf(c), admin: p.admin || null, me: c === meJid }
    })
    const rank = (m) => (m.me ? 0 : m.admin === 'superadmin' ? 1 : m.admin ? 2 : 3)
    members.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    const mine = members.find((m) => m.me)
    return { jid, subject: md.subject || this.store.displayName(jid), members, amAdmin: !!mine?.admin }
  }

  /** Add or remove people. WhatsApp only allows this for group admins. */
  async groupParticipants(jid, action, ids) {
    this.ensureConnected()
    jid = this.store.canon(jid)
    if (!isGroup(jid)) throw Object.assign(new Error('Not a group'), { status: 400 })
    if (!['add', 'remove'].includes(action)) throw Object.assign(new Error('Unknown action'), { status: 400 })
    ids = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 20)
    if (!ids.length) throw Object.assign(new Error('Nobody selected'), { status: 400 })
    const res = await this.sock.groupParticipantsUpdate(jid, ids, action)
    const text = {
      200: action === 'add' ? 'Added' : 'Removed',
      403: "Can't add them: their privacy settings don't allow it. Send them the invite link instead.",
      408: 'They left recently, so WhatsApp won\'t re-add them yet. Send them the invite link.',
      409: action === 'add' ? 'Already in the group' : 'Not in the group',
      401: 'Only group admins can do that',
      500: 'The group is full',
    }
    this.groupCache.delete(jid)
    return (res || []).map((r) => {
      const code = Number(r.status)
      return { id: r.jid || r.id, status: code, ok: code === 200, text: text[code] || `WhatsApp said no (${r.status})` }
    })
  }

  async groupInvite(jid) {
    this.ensureConnected()
    const code = await this.sock.groupInviteCode(this.store.canon(jid))
    return { link: `https://chat.whatsapp.com/${code}` }
  }

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

  // ------------------------------------------------------ profile pictures
  // Fetched only when a picture is actually shown, cached on the volume for a
  // day, and at most two lookups at a time so long chat lists don't trip
  // WhatsApp's rate limits.
  async avatar(jid) {
    jid = this.store.canon(jid || this.me?.jid || '')
    if (!jid) return null
    const dir = path.join(this.dir, 'avatars')
    const key = crypto.createHash('sha1').update(jid).digest('hex').slice(0, 16)
    const file = path.join(dir, key + '.jpg')
    const none = path.join(dir, key + '.none')
    const age = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs } catch { return Infinity } }
    const read = () => { try { return fs.readFileSync(file) } catch { return null } }
    if (age(file) < 24 * 3600e3) return read()
    if (age(none) < 6 * 3600e3) return null
    if (!this.sock || this.status !== 'connected') return read() // offline: serve a stale copy if we have one

    this.avatarInflight ??= new Map()
    if (this.avatarInflight.has(jid)) return this.avatarInflight.get(jid)
    const job = this.avatarQueue(async () => {
      // try the phone address first, then any LID we know for it
      const tries = [jid, ...[...this.store.alias].filter(([, pn]) => pn === jid).map(([lid]) => lid)]
      let url = null
      let hidden = false
      for (const j of tries) {
        try {
          url = await this.sock.profilePictureUrl(j, 'preview')
          if (url) break
        } catch (e) {
          const code = e?.output?.statusCode ?? e?.data?.code
          if ([401, 403, 404].includes(Number(code))) hidden = true // no picture, or privacy
          else throw e // rate limit / network: don't cache, try again later
        }
      }
      fs.mkdirSync(dir, { recursive: true })
      if (!url) {
        if (hidden || tries.length) fs.writeFileSync(none, '')
        fs.rmSync(file, { force: true })
        return null
      }
      const r = await fetch(url)
      if (!r.ok) throw new Error(`picture download failed (${r.status})`)
      const buf = Buffer.from(await r.arrayBuffer())
      fs.writeFileSync(file, buf)
      fs.rmSync(none, { force: true })
      return buf
    })
    this.avatarInflight.set(jid, job)
    try {
      return await job
    } catch (e) {
      return read()
    } finally {
      this.avatarInflight.delete(jid)
    }
  }

  avatarQueue(fn) {
    const q = (this.aq ??= { active: 0, waiting: [] })
    return new Promise((resolve, reject) => {
      const run = async () => {
        q.active++
        try { resolve(await fn()) } catch (e) { reject(e) } finally { q.active--; q.waiting.shift()?.() }
      }
      if (q.active < 2) run()
      else q.waiting.push(run)
    })
  }

  /** Archive / unarchive on this site only. WhatsApp is never told. */
  async setArchived(jid, archived) {
    jid = this.store.canon(jid)
    // like WhatsApp: an archived chat can't stay pinned
    this.store.touchChat(jid, archived ? { localArchived: true, localPinned: false } : { localArchived: false })
    this.emit('event', { type: 'chats' })
    return { archived: !!archived }
  }

  /** Pin / unpin on this site only. Pinning brings a chat out of the archive. */
  async setPinned(jid, pinned) {
    jid = this.store.canon(jid)
    this.store.touchChat(jid, pinned ? { localPinned: true, localArchived: false } : { localPinned: false })
    this.emit('event', { type: 'chats' })
    return { pinned: !!pinned }
  }

  async markRead(jid) {
    this.metrics.lastEventAt = Date.now()
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
    let raw = fromJsonSafe(m.rm)
    let lastError

    for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const buffer = await B.downloadMediaMessage(raw, 'buffer', {}, {
          logger: silent,
          reuploadRequest: this.sock?.updateMediaMessage,
        })
        const sub = Object.values(raw.message || {})[0] || {}
        return { buffer, mime: sub.mimetype || 'application/octet-stream', fileName: sub.fileName }
      } catch (e) {
        lastError = e
        if (attempt === MEDIA_DOWNLOAD_ATTEMPTS) break

        // Media URLs can fail independently of the WhatsApp websocket.
        // Retry the request first; on the final retry before backing off,
        // ask WhatsApp for a fresh media URL when the socket supports it.
        if (attempt === MEDIA_DOWNLOAD_ATTEMPTS - 1 && typeof this.sock?.updateMediaMessage === 'function') {
          try {
            const refreshed = await this.sock.updateMediaMessage(raw)
            if (refreshed?.message) raw = refreshed
          } catch (refreshError) {
            this.log('media reupload refresh failed:', refreshError?.message || refreshError)
          }
        }
        await sleep(350 * 2 ** (attempt - 1))
      }
    }

    const e = lastError instanceof Error ? lastError : new Error(String(lastError || 'Media download failed'))
    this.metrics.lastMediaError = { at: Date.now(), jid: this.store.canon(jid), id, error: e.message }
    this.metrics.lastEventAt = Date.now()
    this.log(`media download failed ${jid}/${id} after ${MEDIA_DOWNLOAD_ATTEMPTS} attempts:`, e.message)
    throw e
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

function textOf(c) {
  if (!c) return null
  if (typeof c.conversation === 'string') return c.conversation
  return c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? c.documentMessage?.caption ?? null
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
