import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { HttpError } from './auth.js'
import { validTz } from './tz.js'

/**
 * Web push: the server keeps each person's devices (browser push
 * subscriptions) and sends them notifications, so reminders arrive even when
 * the site is closed. Keys (VAPID) come from the environment or are made on
 * first boot and kept on the volume.
 */

const MAX_DEVICES = 10

export class Push {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'push')
    fs.mkdirSync(this.dir, { recursive: true })
    const keyFile = path.join(dataDir, '.vapid.json')
    let keys = null
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      keys = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() }
    } else {
      try { keys = JSON.parse(fs.readFileSync(keyFile, 'utf8')) } catch {}
      if (!keys?.publicKey) {
        keys = webpush.generateVAPIDKeys()
        fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 })
      }
    }
    this.publicKey = keys.publicKey
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com/patricktechyy/ming2-s-todolist-website', keys.publicKey, keys.privateKey)
  }

  file(username) {
    return path.join(this.dir, `${username}.json`)
  }

  devices(username) {
    try { return JSON.parse(fs.readFileSync(this.file(username), 'utf8')).devices || [] } catch { return [] }
  }

  save(username, devices) {
    const tmp = `${this.file(username)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ devices }), { mode: 0o600 })
    fs.renameSync(tmp, this.file(username))
  }

  /** The timezone of the person's most recently added device (for reminder times). */
  timezone(username) {
    const d = this.devices(username)
    return d.length ? d[d.length - 1].tz : null
  }

  subscribe(username, body) {
    const sub = body?.subscription
    const endpoint = sub?.endpoint
    if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint) || endpoint.length > 2000) throw new HttpError(400, 'Invalid push subscription')
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') throw new HttpError(400, 'Invalid push subscription keys')
    const tz = validTz(body.tz) ? body.tz : 'UTC'
    const before = this.devices(username).find((d) => d.subscription.endpoint === endpoint)
    const devices = this.devices(username).filter((d) => d.subscription.endpoint !== endpoint)
    // wa: this device also gets WhatsApp message notifications (switched on from Whats Up; kept when the Todolist re-subscribes)
    const wa = typeof body.wa === 'boolean' ? body.wa : !!before?.wa
    devices.push({ subscription: { endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, tz, addedAt: before?.addedAt || Date.now(), ...(wa ? { wa: true } : {}) })
    this.save(username, devices.slice(-MAX_DEVICES))
    return { ok: true, devices: Math.min(devices.length, MAX_DEVICES) }
  }

  /** WhatsApp message notifications on one device, on or off. */
  setWa(username, endpoint, on) {
    const devices = this.devices(username)
    const d = devices.find((x) => x.subscription.endpoint === endpoint)
    if (!d) throw new HttpError(404, 'This device isn’t set up for notifications')
    if (on) d.wa = true
    else delete d.wa
    this.save(username, devices)
    return { ok: true, wa: !!on }
  }

  unsubscribe(username, endpoint) {
    const devices = this.devices(username)
    const left = devices.filter((d) => d.subscription.endpoint !== endpoint)
    if (left.length !== devices.length) this.save(username, left)
    return { ok: true }
  }

  /**
   * Send to every device the person has (or just one, with `only` = its endpoint).
   * Dead subscriptions are forgotten. `errors` says what the push services answered
   * when they refused, so a test can explain itself.
   */
  async send(username, payload, { only = null, filter = null, ttl = 12 * 3600 } = {}) {
    const all = this.devices(username)
    const devices = (only ? all.filter((d) => d.subscription.endpoint === only) : all).filter((d) => !filter || filter(d))
    let sent = 0
    const dead = new Set()
    const errors = []
    await Promise.all(devices.map(async (d) => {
      try {
        await webpush.sendNotification(d.subscription, JSON.stringify(payload), { TTL: ttl, urgency: 'high' })
        sent++
      } catch (e) {
        const host = (() => { try { return new URL(d.subscription.endpoint).host } catch { return '?' } })()
        if (e.statusCode === 404 || e.statusCode === 410) dead.add(d.subscription.endpoint)
        else console.warn(`[push] ${username} (${host}): ${e.statusCode || ''} ${e.body || e.message}`.trim())
        errors.push({ host, status: e.statusCode || null, text: String(e.body || e.message || '').slice(0, 200) })
      }
    }))
    if (dead.size) this.save(username, all.filter((d) => !dead.has(d.subscription.endpoint)))
    return { sent, devices: devices.length - dead.size, errors }
  }
}
