import fs from 'node:fs'
import path from 'node:path'
import { zonedTime, todayIn } from './tz.js'
import { reminderMessage } from './whatsapp.js'

/**
 * Every 30 seconds, look through everyone's tasks and push any reminder whose
 * time has come. Times are worked out in the person's own timezone (sent by
 * their browser), since the server itself runs in UTC.
 */

const LATE_LIMIT = 12 * 3600 * 1000 // don't ring for reminders missed by more than 12h
const FORGET = 30 * 24 * 3600 * 1000

export const reminderKey = (t) => `${t.id}|${t.due}|${t.time}|${t.remind}`

/** When the task's reminder should go off (date-only tasks are reminded relative to 9am). */
export function reminderInstant(t, tz) {
  if (!t.due || t.remind === null || t.remind === undefined) return null
  return zonedTime(t.due, t.time || '09:00', tz) - t.remind * 60000
}

function formatDue(t) {
  if (!t.time) return 'Due today'
  const [h, m] = t.time.split(':').map(Number)
  return `Due ${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export class Reminders {
  constructor(dataDir, store, push, link = null, buddy = null) {
    this.buddy = buddy // when there is one, WhatsApp reminders come in Buddy's voice (and "td done" works on them)
    this.store = store
    this.push = push
    this.link = link
    this.file = path.join(dataDir, 'push', 'sent.json')
    try { this.sent = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.sent = {} }
  }

  start(every = 30000) {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[reminders]', e)), every)
    this.timer.unref?.()
    setTimeout(() => this.tick().catch(() => {}), 3000).unref?.()
  }

  async tick(now = Date.now()) {
    let changed = false
    const waOn = !!this.link?.enabled('reminders')
    for (const username of this.store.usernames()) {
      const doc = this.store.snapshot(username)
      const toPush = this.push.devices(username).length > 0
      const toWa = waOn && !!doc.profile.waReminders
      if (!toPush && !toWa) continue
      const tz = doc.profile.tz || this.push.timezone(username) || 'UTC'
      for (const t of doc.tasks) {
        if (t.done) continue
        const at = reminderInstant(t, tz)
        if (at === null || at > now || now - at > LATE_LIMIT) continue
        const base = `${username}|${reminderKey(t)}`
        // each channel remembers on its own, so one failing doesn't block the other
        if (toPush && !this.sent[base]) {
          this.sent[base] = now
          changed = true
          const r = await this.push.send(username, {
            title: `🔔 ${t.title}`,
            body: [formatDue(t), t.notes?.split('\n')[0]].filter(Boolean).join(' · '),
            tag: base,
            taskId: t.id,
            kind: 'reminder',
          })
          console.log(`[reminders] ${username}: "${t.title}" → ${r.sent} device(s)`)
        }
        if (toWa && !this.sent[`wa|${base}`]) {
          this.sent[`wa|${base}`] = now
          changed = true
          try {
            if (this.buddy) { await this.buddy.send(username, this.buddy.taskMessage(username, t, { now })); this.buddy.remember(username, [t.id]) }
            else await this.link.call('send', { username, text: reminderMessage(t, todayIn(tz, now)) })
            console.log(`[reminders] ${username}: "${t.title}" → WhatsApp`)
          } catch (e) {
            console.warn(`[reminders] ${username}: WhatsApp failed: ${e.message}`)
          }
        }
      }
    }
    if (changed) {
      for (const [k, v] of Object.entries(this.sent)) if (now - v > FORGET) delete this.sent[k]
      fs.writeFileSync(this.file, JSON.stringify(this.sent))
    }
  }
}
