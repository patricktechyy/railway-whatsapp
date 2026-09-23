import fs from 'node:fs'
import path from 'node:path'

const MAX_CHATS = Number(process.env.MAX_CHATS || 800)
// Message retention is time-based so a busy chat cannot evict recent messages
// simply because it crossed an arbitrary message-count cap. This is especially
// important for groups where thousands of messages can arrive within a day.
// HISTORY_DAYS is the actual retention boundary; default 14 gives a full week
// of scrollback with some breathing room. The admin can change it at runtime,
// but it never goes below MIN_HISTORY_DAYS.
export const MIN_HISTORY_DAYS = 7
const DEFAULT_HISTORY_DAYS = 14
let historyDays = Math.max(MIN_HISTORY_DAYS, Number(process.env.HISTORY_DAYS) || DEFAULT_HISTORY_DAYS)
export const getHistoryDays = () => historyDays
export function setHistoryDays(n) {
  historyDays = Math.min(3650, Math.max(MIN_HISTORY_DAYS, Math.round(Number(n)) || MIN_HISTORY_DAYS))
  return historyDays
}
export const historyCutoff = () => Math.floor(Date.now() / 1000) - historyDays * 86400

export const isLid = (j) => typeof j === 'string' && j.endsWith('@lid')
export const isPn = (j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net')
export const isGroup = (j) => typeof j === 'string' && j.endsWith('@g.us')

/** "123:4@s.whatsapp.net" -> "123@s.whatsapp.net" (strip the device suffix) */
export const bare = (j) => (typeof j === 'string' ? j.replace(/:\d+(?=@)/, '') : j)

/** Accept a JID or a bare phone number and return a phone JID, or null. */
export function toPn(v) {
  if (!v) return null
  if (isPn(v)) return bare(v)
  const digits = String(v).replace(/\D/g, '')
  return /^\d{6,16}$/.test(digits) && !String(v).includes('@') ? `${digits}@s.whatsapp.net` : null
}

/** "+62 812-3456-7890" and the like: a number dressed up as a name. */
export const looksLikePhone = (s) => typeof s === 'string' && /^[+\d\s().-]{6,}$/.test(s.trim())

export const phoneOf = (jid) => (isPn(jid) ? '+' + jid.split('@')[0] : '')

/**
 * Everything lives in Maps; a compact JSON snapshot goes to the volume every
 * few seconds. Chats are keyed by a *canonical* JID: the phone JID when we know
 * it, otherwise the LID. When a LID→phone mapping turns up later, the LID chat
 * is merged into the phone chat so one person never shows up twice.
 */
export class Store {
  constructor(file) {
    this.file = file
    this.chats = new Map() //    jid -> { jid, subject?, t, unread, preview, cap? }
    this.messages = new Map() // jid -> [msg]
    this.contacts = new Map() // jid -> { name?, notify?, verified? }
    this.alias = new Map() //    lid -> phone jid
    this.gone = new Set() //     message ids deleted "for me" (never re-added)
    this.dirty = false
    this.load()
    this.timer = setInterval(() => this.flush(), 5000)
    this.timer.unref?.()
  }

  // ------------------------------------------------------------ persistence
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const c of raw.chats || []) this.chats.set(c.jid, c)
      for (const [jid, c] of raw.contacts || []) {
        // older snapshots stored a plain string name
        this.contacts.set(jid, typeof c === 'string' ? { notify: c } : c)
      }
      for (const [lid, pn] of raw.alias || []) this.alias.set(lid, pn)
      for (const id of raw.gone || []) this.gone.add(id)
      for (const [jid, list] of Object.entries(raw.messages || {})) this.messages.set(jid, list)
    } catch {
      /* first run or unreadable snapshot: start empty */
    }
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      const chats = [...this.chats.values()]
        .sort((a, b) => (b.t || 0) - (a.t || 0))
        .slice(0, MAX_CHATS)
      const keep = new Set(chats.map((c) => c.jid))
      const messages = {}
      const cutoff = historyCutoff()
      for (const [jid, list] of this.messages) {
        // drop anything past the history window, in memory and on disk
        const fresh = list.filter((m) => m.ts >= cutoff)
        if (fresh.length !== list.length) this.messages.set(jid, fresh)
        if (keep.has(jid) && fresh.length) messages[jid] = fresh
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(
        tmp,
        JSON.stringify({ chats, contacts: [...this.contacts], alias: [...this.alias], messages, gone: [...this.gone].slice(-3000) })
      )
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error('store flush failed:', e.message)
    }
  }

  close() {
    clearInterval(this.timer)
    this.flush()
  }

  // ----------------------------------------------------------- identities
  canon(jid) {
    const b = bare(jid)
    return this.alias.get(b) || b
  }

  /** Record lid <-> phone. Returns true if anything changed. */
  link(lid, pn) {
    lid = bare(lid)
    pn = toPn(pn)
    if (!isLid(lid) || !pn || this.alias.get(lid) === pn) return false
    this.alias.set(lid, pn)
    this.merge(lid, pn)
    this.dirty = true
    return true
  }

  /** Link two JIDs where we don't know which one is the LID. */
  linkPair(a, b) {
    if (!a || !b) return false
    if (isLid(a) && (isPn(b) || toPn(b))) return this.link(a, b)
    if (isLid(b) && (isPn(a) || toPn(a))) return this.link(b, a)
    return false
  }

  merge(from, to) {
    const fc = this.contacts.get(from)
    if (fc) {
      this.contacts.set(to, { ...fc, ...pickDefined(this.contacts.get(to)) })
      this.contacts.delete(from)
    }
    const fchat = this.chats.get(from)
    if (fchat) {
      const tchat = this.chats.get(to)
      if (tchat) {
        tchat.unread = (tchat.unread || 0) + (fchat.unread || 0)
        if ((fchat.t || 0) > (tchat.t || 0)) {
          tchat.t = fchat.t
          tchat.preview = fchat.preview
        }
        tchat.cap = Math.max(tchat.cap || 0, fchat.cap || 0) || undefined
      } else {
        this.chats.set(to, { ...fchat, jid: to })
      }
      this.chats.delete(from)
    }
    const fm = this.messages.get(from)
    if (fm) {
      const tm = this.messages.get(to) || []
      const seen = new Set(tm.map((m) => m.id))
      for (const m of fm) if (!seen.has(m.id)) tm.push({ ...m, jid: to })
      tm.sort((a, b) => a.ts - b.ts)
      this.messages.set(to, tm)
      this.messages.delete(from)
    }
  }

  setContact(jid, info = {}) {
    if (!jid) return
    jid = this.canon(jid)
    if (isGroup(jid)) return
    const cur = this.contacts.get(jid) || {}
    info = { ...info }
    for (const k of ['name', 'verified', 'notify']) if (looksLikePhone(info[k])) delete info[k]
    const next = { ...cur, ...pickDefined(info) }
    if (JSON.stringify(cur) === JSON.stringify(next)) return
    this.contacts.set(jid, next)
    this.dirty = true
  }

  setGroup(jid, subject) {
    if (!isGroup(jid) || !subject) return
    const chat = this.chats.get(jid)
    if (chat) {
      if (chat.subject !== subject) {
        chat.subject = subject
        this.dirty = true
      }
    } else {
      this.chats.set(jid, { jid, subject, t: 0, unread: 0, preview: '' })
      this.dirty = true
    }
  }

  displayName(jid) {
    if (!jid) return ''
    jid = this.canon(jid)
    const c = this.contacts.get(jid) || {}
    if (c.nick) return c.nick // local nickname beats everything
    if (isGroup(jid)) return this.chats.get(jid)?.subject || 'Group'
    const ok = (v) => v && !looksLikePhone(v)
    return (ok(c.name) && c.name) || (ok(c.verified) && c.verified) || (ok(c.notify) && c.notify) || phoneOf(jid) || 'Unknown contact'
  }

  /** The name the person set on their own WhatsApp profile, if we've seen it. */
  profileName(jid) {
    const c = this.contacts.get(this.canon(jid)) || {}
    return c.notify && !looksLikePhone(c.notify) ? c.notify : ''
  }

  /** Nickname only this site shows. Empty clears it. Never sent to WhatsApp. */
  setNick(jid, nick) {
    jid = this.canon(jid)
    const c = { ...(this.contacts.get(jid) || {}) }
    nick = String(nick || '').trim().slice(0, 60)
    if (nick) c.nick = nick
    else delete c.nick
    this.contacts.set(jid, c)
    this.dirty = true
    return this.displayName(jid)
  }

  // ------------------------------------------------------------ chats/msgs
  touchChat(jid, patch = {}) {
    let chat = this.chats.get(jid)
    if (!chat) {
      chat = { jid, t: 0, unread: 0, preview: '' }
      this.chats.set(jid, chat)
    }
    if (patch.t != null && patch.t > (chat.t || 0)) chat.t = patch.t
    if (patch.unread != null) chat.unread = patch.unread
    if (patch.localArchived != null) chat.localArchived = !!patch.localArchived
    if (patch.localPinned != null) chat.localPinned = !!patch.localPinned
    this.dirty = true
    return chat
  }

  addMessage(msg, { bumpUnread = false } = {}) {
    if (this.gone.has(msg.id)) return null // deleted for me: never bring it back
    let list = this.messages.get(msg.jid)
    if (!list) {
      list = []
      this.messages.set(msg.jid, list)
    }
    const i = list.findIndex((m) => m.id === msg.id)
    const isNew = i < 0
    if (isNew) list.push(msg)
    else {
      const old = list[i]
      list[i] = { ...old, ...msg }
      // a re-sync of the original must not undo a delete or an edit
      if (old.deleted) Object.assign(list[i], { deleted: true, text: '', rm: undefined, quote: undefined })
      else if (old.edited) Object.assign(list[i], { edited: true, text: old.text })
    }
    if (isNew && list.length > 1 && list[list.length - 2].ts > msg.ts) {
      list.sort((a, b) => a.ts - b.ts)
    }

    const chat = this.touchChat(msg.jid)
    // Do not cap by message count here. Retention is based on timestamp in
    // flush(), which guarantees a busy chat keeps at least the configured
    // number of recent days instead of truncating at an arbitrary count.

    if (msg.ts >= (chat.t || 0)) {
      chat.t = msg.ts
      chat.preview = previewOf(msg, this)
    }
    if (bumpUnread && isNew && !msg.fromMe) chat.unread = (chat.unread || 0) + 1
    this.dirty = true
    return msg
  }

  refreshPreview(jid) {
    const chat = this.chats.get(jid)
    if (!chat) return
    const last = (this.messages.get(jid) || []).at(-1)
    chat.preview = last ? previewOf(last, this) : ''
    this.dirty = true
  }

  /** Delete for me: gone from this site for good. */
  removeMessage(jid, id) {
    jid = this.canon(jid)
    const list = this.messages.get(jid) || []
    const next = list.filter((m) => m.id !== id)
    this.messages.set(jid, next)
    this.gone.add(id)
    this.refreshPreview(jid)
    return next.length !== list.length
  }

  /** Deleted for everyone (by you or by them): keep a placeholder like WhatsApp. */
  markDeleted(jid, id) {
    const m = this.findMessage(jid, id)
    if (!m) return null
    Object.assign(m, { deleted: true, text: '', rm: undefined, quote: undefined, reactions: undefined, edited: false })
    this.refreshPreview(this.canon(jid))
    return m
  }

  markEdited(jid, id, text) {
    const m = this.findMessage(jid, id)
    if (!m || m.deleted) return null
    Object.assign(m, { text: String(text), edited: true })
    this.refreshPreview(this.canon(jid))
    return m
  }

  /** [{t: "6581234567", name: "Budi", me: false}] for highlighting @mentions */
  mentionView(m, mineJid) {
    if (!m.mentions?.length) return undefined
    const mine = mineJid ? this.canon(mineJid) : null
    return m.mentions.map((x) => {
      const me = !!mine && this.canon(x.j) === mine
      return { t: x.t, name: me ? 'You' : this.displayName(x.j), me }
    })
  }

  quoteView(q) {
    if (!q) return undefined
    return { id: q.id, text: q.text, name: q.fromMe ? 'You' : q.sender ? this.displayName(q.sender) : '' }
  }

  findMessage(jid, id) {
    return (this.messages.get(this.canon(jid)) || []).find((m) => m.id === id) || null
  }

  /** Add/replace one user's reaction on a message. Empty emoji removes it. */
  setReaction(jid, id, sender, emoji) {
    const m = this.findMessage(jid, id)
    if (!m || !sender) return null
    const reactions = Array.isArray(m.reactions) ? [...m.reactions] : []
    const idx = reactions.findIndex((r) => r?.sender === sender)
    if (!emoji) {
      if (idx >= 0) reactions.splice(idx, 1)
    } else if (idx >= 0) {
      reactions[idx] = { sender, emoji: String(emoji).slice(0, 16) }
    } else {
      reactions.push({ sender, emoji: String(emoji).slice(0, 16) })
    }
    m.reactions = reactions
    this.dirty = true
    return m
  }

  reactionView(m, mineJid) {
    const rows = Array.isArray(m?.reactions) ? m.reactions : []
    const grouped = new Map()
    for (const r of rows) {
      if (!r?.emoji) continue
      const cur = grouped.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false }
      cur.count++
      if (mineJid && this.canon(r.sender) === this.canon(mineJid)) cur.mine = true
      grouped.set(r.emoji, cur)
    }
    return [...grouped.values()]
  }

  oldest(jid) {
    jid = this.canon(jid)
    return (this.messages.get(jid) || [])[0] || null
  }

  raiseCap(jid, by = 60) {
    // Kept for compatibility with the older fetch-older path. Recent-message
    // retention is now time-based, so there is no per-chat count cap to raise.
    this.touchChat(jid)
    return true
  }

  markRead(jid) {
    const chat = this.chats.get(jid)
    if (chat?.unread) {
      chat.unread = 0
      this.dirty = true
    }
  }

  // ------------------------------------------------------------- views
  chatList() {
    return [...this.chats.values()]
      .filter((c) => c.t)
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .slice(0, MAX_CHATS)
      .map((c) => ({
        jid: c.jid,
        name: this.displayName(c.jid),
        phone: phoneOf(c.jid),
        profile: this.profileName(c.jid),
        t: c.t,
        unread: c.unread || 0,
        preview: c.preview || '',
        group: isGroup(c.jid),
        archived: !!c.localArchived,
        pinned: !!c.localPinned,
      }))
  }

  /** Newest `limit` messages, or a page before `beforeId`, or everything from `sinceId` on. */
  messageList(jid, mineJid, { beforeId, sinceId, limit } = {}) {
    jid = this.canon(jid)
    const group = isGroup(jid)
    let list = this.messages.get(jid) || []
    const n = Math.max(1, Math.min(Number(limit) || 200, 5000))
    if (sinceId) {
      const i = list.findIndex((m) => m.id === sinceId)
      list = i >= 0 ? list.slice(i) : list.slice(-n)
    } else if (beforeId) {
      const i = list.findIndex((m) => m.id === beforeId)
      list = i > 0 ? list.slice(Math.max(0, i - n), i) : []
    } else if (limit) {
      list = list.slice(-n)
    }
    return list.map((m) => ({
      id: m.id,
      jid: m.jid,
      fromMe: m.fromMe,
      status: m.fromMe ? (Number.isFinite(Number(m.status)) ? Math.max(0, Math.min(5, Number(m.status))) : 2) : undefined,
      rsum: m.fromMe && m.rsum ? m.rsum : undefined,
      ts: m.ts,
      type: m.type,
      text: m.text,
      media: !!m.rm,
      fileName: m.fileName,
      quote: this.quoteView(m.quote),
      deleted: !!m.deleted,
      edited: !!m.edited,
      senderName: group && !m.fromMe && m.sender ? this.displayName(m.sender) : '',
      sender: group && !m.fromMe ? m.sender : undefined,
      reactions: this.reactionView(m, mineJid),
      mentions: this.mentionView(m, mineJid),
    }))
  }

  /** People you can start a chat with: contacts + existing chats. */
  contactList(q = '', limit = 60) {
    const needle = q.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    const seen = new Set()
    const out = []
    const consider = (jid) => {
      jid = this.canon(jid)
      if (seen.has(jid) || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return
      seen.add(jid)
      const name = this.displayName(jid)
      const phone = phoneOf(jid)
      if (isLid(jid) && name === 'Unknown contact') return
      if (needle) {
        const hit =
          name.toLowerCase().includes(needle) || (digits.length >= 3 && phone.replace(/\D/g, '').includes(digits))
        if (!hit) return
      }
      out.push({ jid, name, phone, group: isGroup(jid), t: this.chats.get(jid)?.t || 0 })
    }
    for (const jid of this.chats.keys()) consider(jid)
    for (const jid of this.contacts.keys()) consider(jid)
    out.sort((a, b) => (b.t || 0) - (a.t || 0) || a.name.localeCompare(b.name))
    return out.slice(0, limit)
  }

  pendingLids() {
    const s = new Set()
    for (const jid of this.chats.keys()) if (isLid(jid)) s.add(jid)
    for (const jid of this.contacts.keys()) if (isLid(jid)) s.add(jid)
    return [...s]
  }
}

function pickDefined(o = {}) {
  const r = {}
  for (const [k, v] of Object.entries(o || {})) if (v != null && v !== '') r[k] = v
  return r
}

export function previewOf(msg, store) {
  if (msg.deleted) return msg.fromMe ? '🚫 You deleted this message' : '🚫 This message was deleted'
  const body =
    msg.text && msg.type !== 'document'
      ? msg.text
      : {
          image: '📷 Photo',
          video: '🎥 Video',
          audio: '🎤 Voice message',
          document: '📄 ' + (msg.fileName || msg.text || 'Document'),
          sticker: 'Sticker',
          location: '📍 Location',
          contact: '👤 Contact',
        }[msg.type] || ''
  // "@6581234567" reads better as "@Budi" in the chat list
  let bodyText = body
  if (msg.mentions?.length && store) {
    for (const x of msg.mentions) bodyText = bodyText.split('@' + x.t).join('@' + store.displayName(x.j))
  }
  const who = msg.fromMe
    ? 'You: '
    : isGroup(msg.jid) && msg.sender && store
      ? store.displayName(msg.sender) + ': '
      : ''
  return who + bodyText
}
