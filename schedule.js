import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './auth.js'

/**
 * Scheduled messages: write it now, it's sent at the time you pick, from your own
 * WhatsApp, like you'd typed it then. Kept on the volume, so a redeploy doesn't lose
 * them. If WhatsApp isn't connected at that moment it keeps trying for 12 hours,
 * then gives up and says so.
 */

const MAX_PER_USER = 200
const GIVE_UP = 12 * 3600e3
const JID_RE = /^[0-9a-z.:_-]{3,80}@(s\.whatsapp\.net|g\.us|lid)$/i

export class Scheduler {
  /** `sessions`: username → Session (the same Map the server keeps). */
  constructor(dataDir, sessions) {
    this.file = path.join(dataDir, 'scheduled.json')
    this.sessions = sessions
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || [] } catch { this.items = [] }
    this.busy = false
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  view = (x) => ({ id: x.id, jid: x.jid, text: x.text, at: x.at, failed: x.failed || null })

  list(u, jid = null) {
    return this.items.filter((x) => x.u === u && (!jid || x.jid === jid)).sort((a, b) => a.at - b.at).map(this.view)
  }

  add(u, { jid, text, at }) {
    jid = String(jid || '')
    text = String(text || '').trim()
    at = Math.round(Number(at))
    if (!JID_RE.test(jid)) throw new HttpError(400, 'Pick a chat')
    if (!text) throw new HttpError(400, 'Write the message first')
    if (text.length > 4000) throw new HttpError(400, 'That message is too long to schedule')
    if (!Number.isFinite(at) || at < Date.now() + 30e3) throw new HttpError(400, 'Pick a time in the future')
    if (at > Date.now() + 366 * 864e5) throw new HttpError(400, 'Pick a time within the next year')
    if (this.items.filter((x) => x.u === u).length >= MAX_PER_USER) throw new HttpError(400, 'You have a lot of scheduled messages already')
    const item = { id: crypto.randomBytes(6).toString('base64url'), u, jid, text, at, createdAt: Date.now() }
    this.items.push(item)
    this.save()
    this.tell(u, jid)
    return this.view(item)
  }

  cancel(u, id) {
    const item = this.items.find((x) => x.u === u && x.id === id)
    if (!item) throw new HttpError(404, 'That scheduled message is gone (already sent?)')
    if (item.sending) throw new HttpError(409, 'It’s being sent right now')
    this.items = this.items.filter((x) => x !== item)
    this.save()
    this.tell(u, item.jid)
    return { ok: true }
  }

  /** An account was removed: its scheduled messages go too. */
  forget(u) {
    const before = this.items.length
    this.items = this.items.filter((x) => x.u !== u)
    if (this.items.length !== before) this.save()
  }

  /** Open pages of that person refresh their list. */
  tell(u, jid) {
    try { this.sessions.get(u)?.emit('event', { type: 'scheduled', jid }) } catch {}
  }

  start(every = 15000) {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[scheduled]', e)), every)
    this.timer.unref?.()
  }

  async tick(now = Date.now()) {
    if (this.busy) return
    const due = this.items.filter((x) => x.at <= now && !x.failed)
    if (!due.length) return
    this.busy = true
    try {
      for (const item of due) {
        if (!this.items.includes(item)) continue // cancelled while an earlier one was sending
        const s = this.sessions.get(item.u)
        if (!s) { this.items = this.items.filter((x) => x !== item); continue }
        if (s.status !== 'connected' || !s.sock) {
          if (now - item.at > GIVE_UP) { item.failed = 'WhatsApp wasn’t connected'; this.tell(item.u, item.jid) }
          continue
        }
        item.sending = true
        try {
          await s.send(item.jid, item.text)
          this.items = this.items.filter((x) => x !== item)
          this.save() // straight away, so a restart never sends it twice
          console.log(`[scheduled] ${item.u}: sent to ${item.jid}`)
        } catch (e) {
          if (now - item.at > GIVE_UP) item.failed = String(e.message || e).slice(0, 120)
          console.warn(`[scheduled] ${item.u}: ${e.message}`)
        } finally {
          delete item.sending
        }
        this.tell(item.u, item.jid)
      }
      this.save()
    } finally {
      this.busy = false
    }
  }
}
