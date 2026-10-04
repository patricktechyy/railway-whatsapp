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
    const devices = this.devices(username).filter((d) => d.subscription.endpoint !== endpoint)
    devices.push({ subscription: { endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, tz, addedAt: Date.now() })
    this.save(username, devices.slice(-MAX_DEVICES))
    return { ok: true, devices: Math.min(devices.length, MAX_DEVICES) }
  }

  unsubscribe(username, endpoint) {
    const devices = this.devices(username)
    const left = devices.filter((d) => d.subscription.endpoint !== endpoint)
    if (left.length !== devices.length) this.save(username, left)
    return { ok: true }
  }

  /** Send to every device the person has. Dead subscriptions are forgotten. */
  async send(username, payload) {
    const devices = this.devices(username)
    let sent = 0
    const dead = new Set()
    await Promise.all(devices.map(async (d) => {
      try {
        await webpush.sendNotification(d.subscription, JSON.stringify(payload), { TTL: 12 * 3600, urgency: 'high' })
        sent++
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.add(d.subscription.endpoint)
        else console.warn(`[push] ${username}: ${e.statusCode || ''} ${e.body || e.message}`.trim())
      }
    }))
    if (dead.size) this.save(username, devices.filter((d) => !dead.has(d.subscription.endpoint)))
    return { sent, devices: devices.length - dead.size }
  }
}
