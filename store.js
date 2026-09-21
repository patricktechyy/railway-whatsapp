import fs from 'node:fs'
import path from 'node:path'

const MAX_CHATS = 400
const MAX_MSGS_PER_CHAT = 120

/**
 * Tiny store: everything lives in Maps, and a compact JSON snapshot is written
 * to the volume so recent history survives a restart. No database, no ORM.
 */
export class Store {
  constructor(file) {
    this.file = file
    this.chats = new Map()     // jid -> { jid, name, t, unread, preview }
    this.messages = new Map()  // jid -> [ msg ]
    this.contacts = new Map()  // jid -> name
    this.dirty = false
    this.load()
    this.timer = setInterval(() => this.flush(), 5000)
    this.timer.unref?.()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const c of raw.chats || []) this.chats.set(c.jid, c)
      for (const [jid, name] of raw.contacts || []) this.contacts.set(jid, name)
      for (const [jid, list] of Object.entries(raw.messages || {})) {
        this.messages.set(jid, list)
      }
    } catch {
      /* first run, or a corrupt snapshot — start empty */
    }
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      // keep only the most recent chats so the snapshot stays small
      const chats = [...this.chats.values()]
        .sort((a, b) => (b.t || 0) - (a.t || 0))
        .slice(0, MAX_CHATS)
      const keep = new Set(chats.map((c) => c.jid))
      const messages = {}
      for (const [jid, list] of this.messages) {
        if (keep.has(jid)) messages[jid] = list.slice(-MAX_MSGS_PER_CHAT)
      }
      const tmp = this.file + '.tmp'
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(
        tmp,
        JSON.stringify({ chats, contacts: [...this.contacts], messages })
      )
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error('store flush failed:', e.message)
    }
  }

  setContact(jid, name) {
    if (!jid || !name) return
    if (this.contacts.get(jid) === name) return
    this.contacts.set(jid, name)
    const chat = this.chats.get(jid)
    if (chat && !chat.nameLocked) {
      chat.name = name
      this.dirty = true
    }
    this.dirty = true
  }

  displayName(jid) {
    if (!jid) return ''
    return (
      this.contacts.get(jid) ||
      this.chats.get(jid)?.name ||
      jid.split('@')[0].split(':')[0]
    )
  }

  touchChat(jid, patch = {}) {
    let chat = this.chats.get(jid)
    if (!chat) {
      chat = { jid, name: this.displayName(jid), t: 0, unread: 0, preview: '' }
      this.chats.set(jid, chat)
    }
    Object.assign(chat, patch)
    if (!chat.name) chat.name = this.displayName(jid)
    this.dirty = true
    return chat
  }

  addMessage(msg, { bumpUnread = false } = {}) {
    let list = this.messages.get(msg.jid)
    if (!list) {
      list = []
      this.messages.set(msg.jid, list)
    }
    const i = list.findIndex((m) => m.id === msg.id)
    if (i >= 0) list[i] = { ...list[i], ...msg }
    else list.push(msg)

    list.sort((a, b) => a.ts - b.ts)
    if (list.length > MAX_MSGS_PER_CHAT) list.splice(0, list.length - MAX_MSGS_PER_CHAT)

    const chat = this.touchChat(msg.jid)
    if (msg.ts >= (chat.t || 0)) {
      chat.t = msg.ts
      chat.preview = previewOf(msg)
    }
    if (bumpUnread && !msg.fromMe) chat.unread = (chat.unread || 0) + 1
    this.dirty = true
    return msg
  }

  chatList() {
    return [...this.chats.values()]
      .filter((c) => c.t)
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .slice(0, MAX_CHATS)
      .map((c) => ({
        jid: c.jid,
        name: c.name || this.displayName(c.jid),
        t: c.t,
        unread: c.unread || 0,
        preview: c.preview || '',
        group: c.jid.endsWith('@g.us'),
      }))
  }

  messageList(jid) {
    return this.messages.get(jid) || []
  }

  markRead(jid) {
    const chat = this.chats.get(jid)
    if (chat && chat.unread) {
      chat.unread = 0
      this.dirty = true
    }
  }
}

export function previewOf(msg) {
  const body =
    msg.text ||
    { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Voice message', document: '📄 Document', sticker: 'Sticker', location: '📍 Location', contact: '👤 Contact' }[msg.type] ||
    ''
  return (msg.fromMe ? 'You: ' : msg.senderName ? `${msg.senderName}: ` : '') + body
}
