import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { zonedTime } from './tz.js'

/**
 * Your tasks in your phone's calendar: a private address (with a secret in it) that
 * Google Calendar, Apple Calendar or Outlook subscribe to. They fetch it every so
 * often, so changes show up there after a while (Google can take hours).
 *
 * Tasks with a date become events: all-day without a time, a 30-minute event with
 * one (with an alert at its reminder time). Group tasks given to you, or to nobody,
 * are in it too. Finished tasks drop off.
 */

const ESC = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const dateOnly = (k) => k.replace(/-/g, '')
const nextDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '') }

/** Lines longer than 75 bytes are folded, as the format wants. */
function fold(line) {
  const out = []
  let cur = ''
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' ' + ch } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n')
}

export class CalendarFeeds {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'calendar.json')
    try { this.tokens = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.tokens = {} }
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.tokens), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
  /** The person's secret (made on first use); `fresh` makes a new one, so the old address stops working. */
  token(u, fresh = false) {
    if (fresh || !this.tokens[u]) { this.tokens[u] = crypto.randomBytes(18).toString('base64url'); this.save() }
    return this.tokens[u]
  }
  /** Whose feed this secret opens, or null. */
  owner(token) {
    if (typeof token !== 'string' || token.length < 20) return null
    for (const [u, t] of Object.entries(this.tokens)) {
      if (t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) return u
    }
    return null
  }
  forget(u) { if (this.tokens[u]) { delete this.tokens[u]; this.save() } }

  /** The .ics text. `items` are { task, group? } with tasks that have a date. */
  ics({ name, tz, items, host }) {
    const now = utc(Date.now())
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Whats Up//Todolist//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${ESC(name)}`, `X-WR-TIMEZONE:${ESC(tz)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ]
    for (const { task: t, group } of items) {
      if (t.done || !t.due) continue
      lines.push('BEGIN:VEVENT', `UID:${t.id}${group ? `-${group.id}` : ''}@${host}`, `DTSTAMP:${now}`, `LAST-MODIFIED:${utc(t.updatedAt || Date.now())}`)
      if (t.time) {
        const start = zonedTime(t.due, t.time, tz)
        lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(start + 30 * 60e3)}`)
      } else {
        lines.push(`DTSTART;VALUE=DATE:${dateOnly(t.due)}`, `DTEND;VALUE=DATE:${nextDay(t.due)}`, 'TRANSP:TRANSPARENT')
      }
      lines.push(`SUMMARY:${ESC(group ? `${t.title} (${group.emoji} ${group.name})` : t.title)}`)
      const desc = [t.notes, ...(t.subtasks || []).map((s) => `${s.done ? '☑' : '☐'} ${s.title}`)].filter(Boolean).join('\n')
      if (desc) lines.push(`DESCRIPTION:${ESC(desc)}`)
      if (t.time && t.remind !== null && t.remind !== undefined) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${ESC(t.title)}`, `TRIGGER:-PT${t.remind}M`, 'END:VALARM')
      }
      lines.push('END:VEVENT')
    }
    lines.push('END:VCALENDAR')
    return lines.map(fold).join('\r\n') + '\r\n'
  }
}
