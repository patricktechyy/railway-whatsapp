import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './auth.js'

/**
 * The Todolist's way into WhatsApp, now that it lives inside Whats Up: no network
 * calls, no shared keys. It talks straight to the WhatsApp sessions running in this
 * same process (one per Whats Up account), with the same small interface the
 * Todolist has always used: status, chats, send and ping.
 *
 * The admin's switches (which WhatsApp features are on) and announcements are
 * kept in settings.json next to the Todolist's data.
 */

export const DEFAULT_FEATURES = { reminders: true, share: true, inbox: true, buddy: true }

export class LocalLink {
  /** `sessions` is Whats Up's Map of username → Session. */
  constructor(dataDir, sessions) {
    this.sessions = sessions
    this.file = path.join(dataDir, 'settings.json')
  }

  get configured() { return true }

  // ------------------------------------------------------------ settings
  settings() {
    let s = {}
    try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
    return { whatsapp: { ...DEFAULT_FEATURES, ...(s.whatsapp || {}) }, announcements: s.announcements || [], bot: typeof s.bot === 'string' ? s.bot : null }
  }

  saveSettings(next) {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, this.file)
  }

  /** Is this WhatsApp feature switched on by the admin? */
  enabled(feature) { return !!this.settings().whatsapp[feature] }

  require(feature) {
    if (!this.settings().whatsapp[feature]) throw new HttpError(403, 'Your admin has turned this WhatsApp feature off.')
  }

  // ------------------------------------------------------------- sessions
  /** What we can say about someone's WhatsApp without touching their chats. */
  status(username) {
    const s = this.sessions.get(username)
    if (!s) return { exists: false }
    return { exists: true, connected: s.status === 'connected', status: s.status, phone: s.me?.phone || '' }
  }

  async call(endpoint, p = {}) {
    if (endpoint === 'ping') return { ok: true, app: 'whatsup', accounts: this.sessions.size }
    if (endpoint === 'status') {
      const st = this.status(p.username)
      if (!st.exists) throw new HttpError(404, 'No WhatsApp account')
      return st
    }
    const s = this.sessions.get(p.username)
    if (!s) throw new HttpError(404, 'No WhatsApp account')
    if (endpoint === 'chats') return { chats: s.store.contactList(String(p.q || ''), 40) }
    if (endpoint === 'send') {
      if (s.status !== 'connected' || !s.sock) {
        throw new HttpError(503, `The WhatsApp of “${s.label || p.username}” isn’t connected right now (status: ${s.status})`)
      }
      // no chat given: the person's own "Message yourself" chat
      const jid = p.jid || s.me?.jid
      if (!jid) throw new HttpError(503, 'WhatsApp is still connecting')
      try {
        const m = await s.send(jid, String(p.text || '').slice(0, 60000))
        return { ok: true, id: m?.id || null, jid: s.store.canon(jid) }
      } catch (e) {
        throw new HttpError(e.status || 502, `WhatsApp didn’t take the message: ${e.message}`)
      }
    }
    if (endpoint === 'delete-message') {
      if (s.status !== 'connected' || !s.sock) {
        throw new HttpError(503, `The WhatsApp of “${s.label || p.username}” isn’t connected right now (status: ${s.status})`)
      }
      const jid = s.store.canon(String(p.jid || ''))
      const id = String(p.id || '')
      if (!jid || !id) throw new HttpError(400, 'jid and id required')
      try {
        return await s.deleteMessage(jid, id, true)
      } catch (e) {
        throw new HttpError(e.status || 502, `WhatsApp couldn’t remove the message: ${e.message}`)
      }
    }
    throw new HttpError(404, `Unknown WhatsApp call: ${endpoint}`)
  }
}
