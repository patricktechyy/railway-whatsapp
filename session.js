import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { Store, bare, isGroup, isLid, isPn, phoneOf, toPn } from './store.js'

// Ask the phone for the full backlog at pairing time. Set FULL_HISTORY=0 to
// only take the recent slice (lighter pairing spike on huge accounts).
const FULL_HISTORY = process.env.FULL_HISTORY !== '0'

// Baileys wants a pino-shaped logger. A stub keeps pino out of the image.
const silent = {
  level: 'silent',
  child: () => silent,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
}

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
    Browsers: pick('Browsers'),
  }
  return cached
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

const num = (t) => (t == null ? 0 : typeof t === 'object' && t.toNumber ? t.toNumber() : Number(t) || 0)

export class Session extends EventEmitter {
  constructor({ key, label, dir }) {
    super()
    this.setMaxListeners(50)
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
    this.gen = 0
    this.stopped = false
    fs.mkdirSync(this.authDir, { recursive: true })
  }

  log(...a) {
    console.log(`[${this.key}]`, ...a)
  }

  setStatus(status) {
    this.status = status
    this.emit('event', { type: 'status', status, me: this.me, qr: this.qr })
  }

  info() {
    return { status: this.status, qr: this.qr, me: this.me, label: this.label }
  }

  // ------------------------------------------------------------ lifecycle
  async start() {
    if (this.stopped) return
    const gen = ++this.gen
    const B = await loadBaileys()
    const { state, saveCreds } = await B.useMultiFileAuthState(this.authDir)

    let version
    try {
      ;({ version } = await B.fetchLatestBaileysVersion())
    } catch {
      /* fall back to the version bundled with Baileys */
    }
    if (this.stopped || gen !== this.gen) return

    const sock = B.makeWASocket({
      auth: state,
      version,
      logger: silent,
      // A desktop identity is what makes WhatsApp send the proper backlog.
      browser: B.Browsers?.macOS ? B.Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '14.4.1'],
      syncFullHistory: FULL_HISTORY,
      // Accept every history type. Leaving this out while syncFullHistory is
      // false makes some 7.x builds reject *all* history, including recent.
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false, // keeps notifications on the phone working
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        const m = this.store.findMessage(key.remoteJid, key.id)
        return m?.text && m.type === 'text' ? { conversation: m.text } : undefined
      },
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    })
    this.sock = sock
    const live = () => gen === this.gen && !this.stopped

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      if (!live()) return
      if (u.qr) {
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 })
        this.setStatus('qr')
      }
      if (u.connection === 'open') {
        this.qr = null
        this.attempts = 0
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
        const code = u.lastDisconnect?.error?.output?.statusCode
        const loggedOut = code === (B.DisconnectReason.loggedOut ?? 401)
        if (loggedOut) {
          this.log('logged out: clearing credentials')
          await this.wipeAuth()
          this.me = null
          this.setStatus('logged-out')
          if (!this.stopped) setTimeout(() => this.start().catch(console.error), 1500)
          return
        }
        const restart = code === (B.DisconnectReason.restartRequired ?? 515)
        this.attempts = restart ? 0 : this.attempts + 1
        const wait = restart ? 200 : Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5))
        this.setStatus('reconnecting')
        this.log(`connection closed (${code}), retrying in ${wait}ms`)
        setTimeout(() => this.start().catch(console.error), wait)
      }
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
    this.store.markRead(jid)
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
    try {
      await this.sock?.logout()
    } catch {
      this.gen++
      try { this.sock?.end?.(undefined) } catch {}
      await this.wipeAuth()
      this.me = null
      this.setStatus('logged-out')
      setTimeout(() => this.start().catch(console.error), 500)
    }
  }

  /** Permanently remove: unlink from the phone and delete everything. */
  async destroy() {
    this.stopped = true
    this.gen++
    clearTimeout(this.lidTimer)
    try { await this.sock?.logout() } catch {}
    try { this.sock?.end?.(undefined) } catch {}
    this.store.close()
    fs.rmSync(this.dir, { recursive: true, force: true })
    this.removeAllListeners()
  }

  shutdown() {
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
