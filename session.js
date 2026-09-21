import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { Store } from './store.js'

const MAX_RAW = 400 // how many media messages we keep decryptable

// Baileys wants a pino-shaped logger. A stub keeps pino out of the bundle.
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
    // older installs still use the scoped name
    mod = await import('@whiskeysockets/baileys')
  }
  const B = mod.default ?? mod
  cached = {
    makeWASocket: B.default ?? B.makeWASocket ?? B,
    useMultiFileAuthState: B.useMultiFileAuthState ?? mod.useMultiFileAuthState,
    DisconnectReason: B.DisconnectReason ?? mod.DisconnectReason ?? {},
    downloadMediaMessage: B.downloadMediaMessage ?? mod.downloadMediaMessage,
    fetchLatestBaileysVersion: B.fetchLatestBaileysVersion ?? mod.fetchLatestBaileysVersion,
  }
  return cached
}

export class Session extends EventEmitter {
  constructor({ id, label, dir }) {
    super()
    this.id = id
    this.label = label
    this.dir = dir
    this.authDir = path.join(dir, 'auth')
    this.store = new Store(path.join(dir, 'store.json'))
    this.raw = new Map() // message id -> raw proto, for media download
    this.status = 'starting'
    this.qr = null
    this.me = null
    this.attempts = 0
    fs.mkdirSync(this.authDir, { recursive: true })
  }

  setStatus(status, extra = {}) {
    this.status = status
    this.emit('event', { type: 'status', status, me: this.me, qr: this.qr, ...extra })
  }

  async start() {
    const B = await loadBaileys()
    const { state, saveCreds } = await B.useMultiFileAuthState(this.authDir)

    let version
    try {
      ;({ version } = await B.fetchLatestBaileysVersion())
    } catch {
      /* offline or rate limited — Baileys falls back to its bundled version */
    }

    const sock = B.makeWASocket({
      auth: state,
      version,
      logger: silent,
      browser: ['wa-lite', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false, // keep phone notifications working
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 })
        this.setStatus('qr')
      }
      if (u.connection === 'open') {
        this.qr = null
        this.attempts = 0
        this.me = sock.user?.id?.split(':')[0] || null
        this.setStatus('connected')
        console.log(`[${this.id}] connected as ${this.me}`)
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode
        const loggedOut = code === (B.DisconnectReason.loggedOut ?? 401)
        if (loggedOut) {
          console.log(`[${this.id}] logged out — clearing credentials`)
          await this.wipeAuth()
          this.me = null
          this.setStatus('logged-out')
          setTimeout(() => this.start().catch(console.error), 1500)
        } else {
          this.attempts++
          const wait = Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5))
          this.setStatus('reconnecting')
          console.log(`[${this.id}] connection closed (${code}), retrying in ${wait}ms`)
          setTimeout(() => this.start().catch(console.error), wait)
        }
      }
    })

    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
      for (const c of contacts) {
        this.store.setContact(c.id, c.name || c.notify || c.verifiedName)
      }
      for (const c of chats) {
        this.store.touchChat(c.id, {
          name: c.name || this.store.displayName(c.id),
          unread: c.unreadCount || 0,
          t: Number(c.conversationTimestamp) || 0,
        })
      }
      for (const m of messages) this.ingest(m, { bumpUnread: false })
      this.emit('event', { type: 'chats' })
    })

    sock.ev.on('contacts.upsert', (cs) => {
      for (const c of cs) this.store.setContact(c.id, c.name || c.notify || c.verifiedName)
      this.emit('event', { type: 'chats' })
    })
    sock.ev.on('contacts.update', (cs) => {
      for (const c of cs) this.store.setContact(c.id, c.name || c.notify || c.verifiedName)
    })

    sock.ev.on('chats.upsert', (cs) => {
      for (const c of cs) {
        this.store.touchChat(c.id, {
          unread: c.unreadCount || 0,
          t: Number(c.conversationTimestamp) || 0,
        })
      }
      this.emit('event', { type: 'chats' })
    })

    sock.ev.on('chats.update', (cs) => {
      for (const c of cs) {
        if (!c.id) continue
        const patch = {}
        if (c.unreadCount != null) patch.unread = c.unreadCount
        if (c.conversationTimestamp) patch.t = Number(c.conversationTimestamp)
        if (Object.keys(patch).length) this.store.touchChat(c.id, patch)
      }
      this.emit('event', { type: 'chats' })
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        const msg = this.ingest(m, { bumpUnread: type === 'notify' })
        if (msg) this.emit('event', { type: 'message', message: msg })
      }
      this.emit('event', { type: 'chats' })
    })
  }

  /** Turn a raw Baileys message into our slim shape and store it. */
  ingest(m, opts) {
    const msg = normalize(m, this.store)
    if (!msg) return null
    if (msg.media) {
      this.raw.set(msg.id, m)
      if (this.raw.size > MAX_RAW) {
        this.raw.delete(this.raw.keys().next().value)
      }
    }
    return this.store.addMessage(msg, opts)
  }

  async send(jid, text) {
    if (!this.sock || this.status !== 'connected') throw new Error('not connected')
    const sent = await this.sock.sendMessage(jid, { text })
    const msg = this.ingest(sent, { bumpUnread: false })
    if (msg) this.emit('event', { type: 'message', message: msg })
    return msg
  }

  async markRead(jid) {
    this.store.markRead(jid)
    try {
      const list = this.store.messageList(jid)
      const last = [...list].reverse().find((m) => !m.fromMe)
      if (last && this.sock) {
        await this.sock.readMessages([
          { remoteJid: jid, id: last.id, participant: last.participant || undefined },
        ])
      }
    } catch {
      /* read receipts are best effort */
    }
  }

  async media(id) {
    const raw = this.raw.get(id)
    if (!raw) return null
    const B = await loadBaileys()
    const buf = await B.downloadMediaMessage(raw, 'buffer', {}, {
      reuploadRequest: this.sock.updateMediaMessage,
    })
    return { buffer: buf, mime: mimeOf(raw) }
  }

  async wipeAuth() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true })
      fs.mkdirSync(this.authDir, { recursive: true })
    } catch (e) {
      console.error('wipeAuth:', e.message)
    }
  }

  async logout() {
    try {
      await this.sock?.logout()
    } catch {
      await this.wipeAuth()
      setTimeout(() => this.start().catch(console.error), 500)
    }
  }
}

// --------------------------------------------------------------- helpers ---

function inner(message) {
  return (
    message?.ephemeralMessage?.message ??
    message?.viewOnceMessage?.message ??
    message?.viewOnceMessageV2?.message ??
    message?.documentWithCaptionMessage?.message ??
    message
  )
}

function mimeOf(raw) {
  const c = inner(raw.message) || {}
  return (
    c.imageMessage?.mimetype ||
    c.videoMessage?.mimetype ||
    c.audioMessage?.mimetype ||
    c.documentMessage?.mimetype ||
    c.stickerMessage?.mimetype ||
    'application/octet-stream'
  )
}

function normalize(m, store) {
  const jid = m.key?.remoteJid
  if (!jid || jid === 'status@broadcast') return null
  const c = inner(m.message)
  if (!c) return null

  // ignore protocol chatter that has nothing to render
  if (c.protocolMessage || c.senderKeyDistributionMessage || c.reactionMessage) return null

  let type = 'text'
  let text = ''
  let media = false

  if (c.conversation) text = c.conversation
  else if (c.extendedTextMessage?.text) text = c.extendedTextMessage.text
  else if (c.imageMessage) { type = 'image'; text = c.imageMessage.caption || ''; media = true }
  else if (c.videoMessage) { type = 'video'; text = c.videoMessage.caption || ''; media = true }
  else if (c.audioMessage) { type = 'audio'; media = true }
  else if (c.stickerMessage) { type = 'sticker'; media = true }
  else if (c.documentMessage) {
    type = 'document'
    text = c.documentMessage.fileName || 'Document'
    media = true
  } else if (c.locationMessage) {
    type = 'location'
    const l = c.locationMessage
    text = `${l.degreesLatitude}, ${l.degreesLongitude}`
  } else if (c.contactMessage) {
    type = 'contact'
    text = c.contactMessage.displayName || 'Contact'
  } else {
    return null // unknown / unsupported type
  }

  const isGroup = jid.endsWith('@g.us')
  const participant = m.key?.participant || undefined
  if (participant && m.pushName) store.setContact(participant, m.pushName)
  if (!isGroup && m.pushName && !m.key.fromMe) store.setContact(jid, m.pushName)

  return {
    id: m.key.id,
    jid,
    fromMe: !!m.key.fromMe,
    ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
    type,
    text,
    media,
    participant,
    senderName: isGroup && participant && !m.key.fromMe ? store.displayName(participant) : '',
  }
}
