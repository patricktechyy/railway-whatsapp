import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { zonedTime, todayIn } from './tz.js'

/**
 * Quick reminders: a second little bot in the same WhatsApp chat as Buddy, with its own
 * "-" prefix and its own voice. It never touches the to-do list.
 *
 *   -reminder 30m buy milk        in 30 minutes
 *   -reminder 5:30pm call mum     today at 5:30 PM (tomorrow if that's already gone)
 *   -reminder tomorrow 8am bus    tomorrow at 8 AM ("tomorrow" alone means 9 AM)
 *   -reminders                    what's coming up, numbered
 *   -cancel 2                     drop number 2 from that list
 *
 * It answers in the chat you wrote in ("Message yourself", or the bot's chat) and the
 * reminder goes off in that same chat. Kept in /data/todo/quickremind.json.
 */

export const PREFIX_RE = /^\s*-\s*(reminders?|remind|cancel|rm)\b/i
const MAX_PER_USER = 50
const MAX_AHEAD = 366 * 24 * 3600e3
const LATE_LIMIT = 12 * 3600e3 // missed by more than this (the server was down): dropped, not sent
const MAX_TEXT = 300

const UNITS = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440 }
const addDaysKey = (k, n) => { const d = new Date(`${k}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const clock = (s) => {
  const m = String(s).toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/)
  if (!m) return null
  let h = Number(m[1]); const mi = Number(m[2] || 0)
  if (mi > 59 || h > 23 || (m[3] && (h < 1 || h > 12))) return null
  if (!m[3] && !m[2]) return null // a bare "5" is a number, not a time
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/**
 * "30m buy milk" → { at, text }. The time comes first: a length of time ("30m", "1h30m",
 * "in 2 hours", "3 days"), a clock time ("5pm", "17:30"), or "today/tonight/tomorrow"
 * with or without a clock time. Returns { error } if there's no time or no text.
 */
export function parseReminder(input, tz = 'UTC', now = Date.now()) {
  let rest = String(input || '').trim().replace(/^in\s+/i, '')
  let at = null
  const today = todayIn(tz, now)
  // lengths of time, as many as given: "1h 30m", "1h30m", "2 hours"
  let mins = 0, any = false, m
  while ((m = rest.match(/^(\d{1,4})\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*/i))) {
    mins += Number(m[1]) * UNITS[m[2].toLowerCase()]
    any = true
    rest = rest.slice(m[0].length)
  }
  if (any) at = now + mins * 60000
  if (!any) {
    const day = rest.match(/^(today|tonight|tomorrow|tmr|besok)\b\s*/i)
    let dateKey = null, time = null
    if (day) {
      rest = rest.slice(day[0].length)
      const w = day[1].toLowerCase()
      dateKey = w === 'tomorrow' || w === 'tmr' || w === 'besok' ? addDaysKey(today, 1) : today
      time = w === 'tonight' ? '20:00' : w === 'today' ? null : '09:00'
    }
    const c = rest.match(/^(?:at\s+)?(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)(?=\s|$)\s*/i)
    const t = c && clock(c[1])
    if (t) { time = t; rest = rest.slice(c[0].length) }
    if (time) {
      at = zonedTime(dateKey || today, time, tz)
      if (!dateKey && at <= now) at = zonedTime(addDaysKey(today, 1), time, tz) // that time has gone today: tomorrow
    }
  }
  const text = rest.replace(/^(?:to|that|:|-)\s+/i, '').trim().slice(0, MAX_TEXT)
  if (at === null) return { error: 'when' }
  if (!text) return { error: 'what' }
  if (at <= now) return { error: 'past' }
  if (at - now > MAX_AHEAD) return { error: 'far' }
  return { at, text }
}

const fmtTime = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
function when(ms, tz, now) {
  const day = todayIn(tz, ms), today = todayIn(tz, now)
  const t = fmtTime(ms, tz)
  if (day === today) return `today at ${t}`
  if (day === addDaysKey(today, 1)) return `tomorrow at ${t}`
  return `${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms))} at ${t}`
}
function inHowLong(ms, now) {
  const m = Math.round((ms - now) / 60000)
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60), r = m % 60
  if (h < 24) return `in ${h} h${r ? ` ${r} min` : ''}`
  return null
}

const HELP = [
  '⏰ *Quick reminders*',
  '',
  '-reminder 30m buy milk',
  '-reminder 5:30pm call mum',
  '-reminder tomorrow 8am bring PE kit',
  '-reminders to see them, -cancel 2 to drop one',
  '',
  '_These stay out of your to-do list._',
].join('\n')

export class QuickReminders {
  /**
   * @param send ({ user, chat, text }) → Promise: posts in the chat the reminder was set in
   * @param tzOf (user) → the person's timezone
   */
  constructor(dataDir, { send, tzOf, enabled = () => true }) {
    this.file = path.join(dataDir, 'quickremind.json')
    this.send = send
    this.tzOf = tzOf
    this.enabled = enabled
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.data = {} }
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
  list(u) { return (this.data[u] || []).slice().sort((a, b) => a.at - b.at) }
  forget(u) { delete this.data[u]; this.save() }

  /** Is this message for the reminder bot? */
  static wants(text) { return PREFIX_RE.test(String(text || '')) }

  /**
   * A "-…" message. `chat` is where it was written ({ via: 'self' } or { via: 'bot', jid }),
   * which is where the answer and the reminder go. Returns the reply text.
   */
  command(u, text, chat, now = Date.now()) {
    if (!this.enabled()) return 'Quick reminders are turned off.'
    const tz = this.tzOf(u) || 'UTC'
    const m = String(text).trim().match(/^-\s*(reminders?|remind|cancel|rm)\b\s*(.*)$/is)
    if (!m) return null
    const cmd = m[1].toLowerCase(), arg = m[2].trim()
    const mine = this.list(u).filter((r) => r.at > now)

    if (cmd === 'reminders' || ((cmd === 'reminder' || cmd === 'remind') && /^(list)?$/i.test(arg))) {
      if (cmd !== 'reminders' && !arg) return HELP
      if (!mine.length) return '⏰ No reminders coming up.\n\nSet one with *-reminder 30m buy milk*'
      return ['⏰ *Coming up*', '', ...mine.map((r, i) => `${i + 1}. ${r.text} · ${when(r.at, tz, now)}`), '', '_-cancel 2 drops number 2_'].join('\n')
    }
    if (cmd === 'cancel' || cmd === 'rm' || /^(cancel|delete|stop)\b/i.test(arg)) {
      const n = Number((cmd === 'cancel' || cmd === 'rm' ? arg : arg.replace(/^(cancel|delete|stop)\s*/i, '')).replace(/^#/, ''))
      if (!Number.isInteger(n) || n < 1) return 'Which one? Send *-reminders* for the numbers, then *-cancel 2*.'
      const r = mine[n - 1]
      if (!r) return `There’s no number ${n}. Send *-reminders* to see them.`
      this.data[u] = (this.data[u] || []).filter((x) => x.id !== r.id)
      this.save()
      return `🗑️ Cancelled: ${r.text}`
    }
    if (/^help$/i.test(arg)) return HELP
    const p = parseReminder(arg, tz, now)
    if (p.error === 'when') return 'When? Start with the time, like *-reminder 30m buy milk* or *-reminder 5pm call mum*.'
    if (p.error === 'what') return 'What should I remind you about? Like *-reminder 30m buy milk*.'
    if (p.error === 'past') return 'That time has already passed.'
    if (p.error === 'far') return 'That’s more than a year away. Try something sooner.'
    if (mine.length >= MAX_PER_USER) return `You have ${MAX_PER_USER} reminders waiting. Cancel some first (*-reminders*).`
    const r = { id: crypto.randomBytes(5).toString('base64url'), at: p.at, text: p.text, created: now, chat: chat?.via === 'bot' ? { via: 'bot', jid: chat.jid } : { via: 'self' } }
    this.data[u] = [...mine, r]
    this.save()
    const soon = inHowLong(p.at, now)
    return `⏰ Okay, ${when(p.at, tz, now)}${soon ? ` (${soon})` : ''}: ${p.text}`
  }

  /** Send every reminder whose time has come (once), then forget it. */
  async tick(now = Date.now()) {
    if (!this.enabled()) return
    for (const u of Object.keys(this.data)) {
      const due = (this.data[u] || []).filter((r) => r.at <= now)
      if (!due.length) continue
      this.data[u] = this.data[u].filter((r) => r.at > now)
      if (!this.data[u].length) delete this.data[u]
      this.save() // first, so nothing goes out twice
      for (const r of due) {
        if (now - r.at > LATE_LIMIT) continue
        const late = now - r.at > 5 * 60e3 ? ` _(was for ${fmtTime(r.at, this.tzOf(u) || 'UTC')})_` : ''
        try { await this.send({ user: u, chat: r.chat, text: `⏰ *Reminder:* ${r.text}${late}` }) }
        catch (e) { console.warn(`[quickremind] ${u}: ${e.message}`) }
      }
    }
  }
  start(every = 30000) {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[quickremind]', e)), every)
    this.timer.unref?.()
  }
}
