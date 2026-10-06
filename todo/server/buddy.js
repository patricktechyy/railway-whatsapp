import fs from 'node:fs'
import path from 'node:path'
import { zonedTime, todayIn } from './tz.js'
import { parseQuickAdd } from './quickadd.js'
import { dayLabel, time12 } from './whatsapp.js'
import { describeRepeat } from './repeat.js'

/**
 * WhatsApp Buddy 🤖: a little reminder bot that lives in your WhatsApp.
 *
 *  • "💬 WhatsApp me" on a task: Buddy messages you about it at the time you chose
 *    (an exact moment, or relative to its due time), in its own voice.
 *  • You answer in the same chat: td done · td start · td snooze 2h · td step · td move …
 *  • "td remind me to call mum at 8pm" makes the task and the reminder in one go.
 *  • Optional ☀️ morning brief and 🌙 evening check-in, with numbered lists ("td done 2").
 *
 * When the admin has picked a bot account (a Whats Up account linked to its own,
 * spare WhatsApp number), Buddy writes from that number like any other contact, so
 * your phone buzzes on real WhatsApp, and you simply reply in that chat (no "td"
 * needed). Without one, Buddy writes into your own "Message yourself" chat and you
 * answer there starting with "td".
 */

/** Two ways Buddy writes: 'friendly' is shown as Long, 'short' as Short. (Old 'coach' settings read as Long.) */
export const STYLES = ['friendly', 'short']

/**
 * The same message for the bot's chat, where you just reply "done" (no "td"):
 * *td done* → *done*, td? → today, td: … → add …
 */
export const plain = (text) => String(text)
  .replace(/ \(start with \*td\*\)/g, ' (just reply here)')
  .replace(/\*td:\*/g, '*add*')
  .replace(/(?<![a-z])td\?/gi, 'today')
  .replace(/(?<![a-z])td:\s?/gi, 'add ')
  .replace(/(?<![a-z])td (?=[a-z])/gi, '')
export const BUDDY_DEFAULTS = { on: false, style: 'friendly', morning: '07:30', evening: '21:00' }
const LATE = 12 * 3600e3 // a reminder missed by more than this (server was down) is skipped
const BRIEF_WINDOW = 3 * 3600e3 // a morning/evening message more than 3h late isn't sent
const MAX_LIST = 12

// ------------------------------------------------------------------ voices
const VOICE = {
  // "Long": the full picture (when it's due, steps, notes), in plain words
  friendly: {
    hello: ['Hi {name}', 'Hey {name}'],
    nudge: ['Reminder:', 'Don’t forget:', 'Coming up:'],
    cheer: [''],
    done: ['✅ Done: *{title}*', '✅ *{title}* ticked off'],
    start: ['▶️ Started *{title}*'],
    snooze: ['⏰ Okay, I’ll remind you again {when}.', '⏰ Snoozed. Back {when}.'],
    morning: ['☀️ Morning {name}', '☀️ Good morning {name}'],
    evening: ['🌙 Evening {name}', '🌙 Hi {name}, here’s how today went'],
    free: ['Nothing due today.'],
    allclear: ['Everything for today is done.', 'All done for today.'],
  },
  // "Short": one line
  short: {
    hello: [''], nudge: [''], cheer: [''],
    done: ['✅ {title}'], start: ['▶️ {title}'], snooze: ['⏰ {when}'],
    morning: ['☀️ Today'], evening: ['🌙 Today'], free: ['Nothing due.'], allclear: ['All done.'],
  },
}
let spin = 0
const say = (style, key, vars = {}) => {
  const list = (VOICE[style] || VOICE.friendly)[key]
  const line = list[(spin++ + Math.floor(Math.random() * list.length)) % list.length]
  return line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
}

// --------------------------------------------------------------- the times
/** When a task's WhatsApp reminder goes off (null: none, or relative with no due date). */
export function waInstant(t, tz) {
  if (!t.wa) return null
  if (typeof t.wa.at === 'number') return t.wa.at
  if (typeof t.wa.before === 'number' && t.due) return zonedTime(t.due, t.time || '09:00', tz) - t.wa.before * 60000
  return null
}
/** Which version of the reminder this is: changing the time (or the due date) makes a new one. */
export const waSig = (t) => (typeof t.wa?.at === 'number' ? `at:${t.wa.at}` : `b:${t.due}|${t.time}|${t.wa?.before}`)

function hmIn(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.hour}:${p.minute}`
}
const addDaysKey = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const ago = (min) => (min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`)

/** "in 25 min", "now", "2 h late", "tomorrow" … for the due line. */
function dueLine(t, tz, now) {
  if (!t.due) return null
  const today = todayIn(tz, now)
  const label = `${dayLabel(t.due, today)}${t.time ? `, ${time12(t.time)}` : ''}`
  if (!t.time) return t.due < today ? `${label} _(overdue)_` : label
  const min = Math.round((zonedTime(t.due, t.time, tz) - now) / 60000)
  if (Math.abs(min) <= 2) return `${label} _(now!)_`
  return min > 0 ? (min < 36 * 60 ? `${label} _(in ${ago(min)})_` : label) : `${label} _(${ago(-min)} late)_`
}

/**
 * When to snooze to. Accepts 10m, 30 min, 2h, 1 hour, 3d, tonight, tomorrow, later,
 * 3pm, 15:30. Returns ms, or null if it doesn't understand.
 */
export function snoozeUntil(when, tz, now = Date.now()) {
  const w = String(when || '').trim().toLowerCase()
  if (!w || w === 'later') return now + 3600e3
  let m = w.match(/^(\d{1,3})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/)
  if (m) {
    const n = Number(m[1]), u = m[2][0]
    const ms = n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 864e5)
    return ms > 0 && ms <= 30 * 864e5 ? now + ms : null
  }
  const today = todayIn(tz, now)
  if (w === 'tonight' || w === 'this evening') { const t = zonedTime(today, '20:00', tz); return t > now ? t : now + 3600e3 }
  if (w === 'tomorrow' || w === 'tmr' || w === 'besok') return zonedTime(addDaysKey(today, 1), '09:00', tz)
  m = w.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (m && (m[3] || m[2])) {
    let h = Number(m[1]); const mi = Number(m[2] || 0)
    if (m[3] === 'pm' && h < 12) h += 12
    if (m[3] === 'am' && h === 12) h = 0
    if (h > 23 || mi > 59) return null
    const hm = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
    let t = zonedTime(today, hm, tz)
    if (t <= now) t = zonedTime(addDaysKey(today, 1), hm, tz)
    return t
  }
  return null
}
const whenText = (ms, tz, now) => {
  const today = todayIn(tz, now), day = todayIn(tz, ms)
  const hm = time12(hmIn(tz, ms))
  return day === today ? `at ${hm}` : `${dayLabel(day, today).toLowerCase()} at ${hm}`
}

/** Days in a row (up to today) with at least one task finished, in the person's own days. */
function streak(tasks, tz, now) {
  const days = new Set(tasks.filter((t) => t.done && t.doneAt).map((t) => todayIn(tz, t.doneAt)))
  let d = todayIn(tz, now)
  if (!days.has(d)) d = addDaysKey(d, -1)
  let n = 0
  while (days.has(d)) { n++; d = addDaysKey(d, -1) }
  return n
}

// ------------------------------------------------------------- the buddy
export class Buddy {
  /**
   * `onTaskChange(task)` is called after Buddy changes a task (so e.g. the admin's
   * progress view updates when you finish a task they gave you).
   */
  constructor(dataDir, store, link, { brand = 'your todolist', onTaskChange = () => {}, getBot = () => String(process.env.BOT_USER || process.env.WA_BOT_USER || '').trim().toLowerCase() || null } = {}) {
    this.store = store
    this.link = link
    this.brand = brand
    this.onTaskChange = onTaskChange
    this.file = path.join(dataDir, 'buddy.json')
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.state = {} }
    this.phones = new Map() // username → { jid, at } (for the bot number)
    this.getBot = getBot // () => the bot account's username, or null
  }

  saveState() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state))
    fs.renameSync(tmp, this.file)
  }
  st(u) {
    const out = (this.state[u] ||= { codes: {}, last: null })
    out.codes ||= {}
    out.sent ||= []
    return out
  }
  /** The numbers in Buddy's last message, so "td done 2" means its second task. */
  remember(u, ids) {
    const s = this.st(u)
    s.codes = Object.fromEntries(ids.map((id, i) => [i + 1, id]))
    s.last = ids.length === 1 ? ids[0] : s.last
    this.saveState()
  }

  settings(u) {
    const b = { ...BUDDY_DEFAULTS, ...(this.store.snapshot(u).profile.buddy || {}) }
    return STYLES.includes(b.style) ? b : { ...b, style: 'friendly' }
  }
  get botUser() { return this.getBot() || null }
  /** Does Buddy write to this person from the bot number (so they reply there, without "td")? */
  viaBot(u) { return !!this.botUser && this.botUser !== u }
  /** Is Buddy usable at all right now (link set up, admin hasn't switched it off)? */
  get available() { return !!this.link?.enabled('reminders') && this.link.settings().whatsapp.buddy !== false }

  // ----------------------------------------------------------- sending
  /** The person's own WhatsApp number (as a chat id): the number they linked to Whats Up. */
  async jidOf(u) {
    const c = this.phones.get(u)
    if (c?.jid && Date.now() - c.at < 3600e3) return c.jid
    let jid = null
    let linked = false
    try {
      const s = await this.link.call('status', { username: u })
      const digits = String(s?.phone || '').replace(/\D/g, '')
      if (digits.length >= 7) jid = `${digits}@s.whatsapp.net`
      // still linked, just reconnecting (after a deploy, say): the number we knew is still theirs
      linked = ['connected', 'starting', 'reconnecting'].includes(s?.status)
    } catch {}
    const st = this.st(u)
    if (jid && st.jid !== jid) { st.jid = jid; this.saveState() }
    if (!jid && linked) jid = st.jid || null
    // unlinked or logged out: forget the old number, so nothing goes to (or is taken from) a phone that isn't theirs any more
    if (!jid && !linked && st.jid) { delete st.jid; this.saveState() }
    this.phones.set(u, { jid, at: Date.now() })
    return jid
  }
  /** Someone's account was removed: forget everything Buddy knew about them. */
  forget(u) {
    delete this.state[u]
    this.phones.delete(u)
    this.saveState()
  }
  /** Which person a WhatsApp number belongs to (for replies to the bot). */
  async userOfJid(jid, people) {
    for (const u of people) if (u !== this.botUser && (await this.jidOf(u)) === jid) return u
    return null
  }
  /**
   * From the bot number when there is one (so the phone buzzes like any message),
   * otherwise into the person's own "Message yourself" chat. If the bot can't send
   * right now (its phone is offline), the "Message yourself" chat is the fallback.
   */
  trackSent(u, result, { session, jid, kind = 'buddy' } = {}) {
    if (!result?.id || !jid || !session) return result
    const s = this.st(u)
    const cutoff = Date.now() - 60 * 3600e3
    s.sent = [...s.sent, { session, jid, id: result.id, at: Date.now(), kind }].filter((x) => x.at >= cutoff).slice(-150)
    this.saveState()
    return result
  }
  async send(u, text, { kind = 'buddy' } = {}) {
    if (this.viaBot(u)) {
      const jid = await this.jidOf(u)
      if (jid) {
        try {
          const result = await this.link.call('send', { username: this.botUser, jid, text: plain(text) })
          return this.trackSent(u, result, { session: this.botUser, jid: result?.jid || jid, kind })
        } catch (e) {
          console.warn(`[buddy] bot couldn't send to ${u} (${e.message}); using their "Message yourself" chat`)
        }
      }
    }
    const result = await this.link.call('send', { username: u, text })
    return this.trackSent(u, result, { session: u, jid: result?.jid, kind })
  }
  /** Best-effort removal of messages Buddy itself sent. WhatsApp limits delete-for-everyone to recent messages. */
  async clearSent(u, kinds = null) {
    const s = this.st(u)
    const wanted = kinds ? new Set(kinds) : null
    const matching = (s.sent || []).filter((x) => !wanted || wanted.has(x.kind))
    if (!matching.length) return { deleted: 0, failed: 0 }
    const keep = (s.sent || []).filter((x) => wanted ? !wanted.has(x.kind) : false)
    let deleted = 0, failed = 0
    for (const m of matching) {
      try {
        await this.link.call('delete-message', { username: m.session, jid: m.jid, id: m.id })
        deleted++
      } catch (e) {
        failed++
        console.warn(`[buddy] couldn't remove ${m.kind} message for ${u}: ${e.message}`)
      }
    }
    s.sent = keep
    this.saveState()
    return { deleted, failed }
  }
  /** How to answer. Written for the "Message yourself" chat ("td …"); plain() drops the "td" for the bot chat. */
  replyHint(_u, cmds) {
    return `↩️ Reply ${cmds}`
  }

  // ----------------------------------------------------------- messages
  ctx(u, now = Date.now()) {
    const doc = this.store.snapshot(u)
    const tz = doc.profile.tz || 'UTC'
    const b = this.settings(u)
    return { doc, tz, style: b.style, name: (doc.profile.name || u).split(' ')[0], now, today: todayIn(tz, now) }
  }

  /** The message about one task. */
  taskMessage(u, t, { why = 'wa', now = Date.now() } = {}) {
    const { doc, tz, style, name } = this.ctx(u, now)
    const due = dueLine(t, tz, now)
    const list = t.listId && doc.lists.find((l) => l.id === t.listId)
    const steps = t.subtasks || []
    const next = steps.find((s) => !s.done)
    const cmds = ['*td done*', t.status !== 'doing' && '*td start*', '*td snooze 1h*', next && '*td step*'].filter(Boolean).join(' · ')
    if (style === 'short') {
      return [`⏰ *${t.title}*${due ? ` · ${due}` : ''}`, next ? `next: ${next.title}` : null, this.replyHint(u, `td done · td snooze 1h${next ? ' · td step' : ''}`)].filter(Boolean).join('\n')
    }
    const lines = [`${say(style, 'hello', { name })}, ${why === 'assigned' ? 'someone gave you a task.' : say(style, 'nudge').toLowerCase().replace(/:$/, '…')}`, '', `📝 *${t.title}*`]
    if (due) lines.push(`📅 ${due}`)
    const meta = [
      t.priority === 3 && '🚩 High priority', t.priority === 2 && '🚩 Medium priority',
      t.status === 'doing' && '◐ In progress', t.repeat && `🔁 ${describeRepeat(t.repeat)}`,
      list && `${list.emoji} ${list.name}`, t.from && `📌 From ${t.from.name}`,
    ].filter(Boolean)
    if (meta.length) lines.push(meta.join(' · '))
    if (steps.length) lines.push(`☑ ${steps.filter((s) => s.done).length}/${steps.length} steps${next ? ` · next: _${next.title}_` : ''}`)
    const note = t.notes?.split('\n').find((l) => l.trim())
    if (note) lines.push(`🗒 _${note.trim().slice(0, 140)}_`)
    lines.push('', this.replyHint(u, cmds))
    return lines.join('\n')
  }

  /** Today's open tasks (overdue first), numbered. */
  todayList(u, now = Date.now()) {
    const { doc, today } = this.ctx(u, now)
    return doc.tasks.filter((t) => !t.done && t.due && t.due <= today)
      .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority)
  }
  numbered(tasks, today) {
    return tasks.slice(0, MAX_LIST).map((t, i) =>
      `${i + 1}. ${t.due < today ? '⚠️' : t.status === 'doing' ? '◐' : '○'} ${t.title}${t.time && t.due === today ? ` · ${time12(t.time)}` : ''}${t.due < today ? ` _(${dayLabel(t.due, today).toLowerCase()})_` : ''}`)
  }
  /** Tasks with a due date in [start, end), keeping the same order as today's list. */
  dateList(u, start, end, now = Date.now()) {
    const { doc } = this.ctx(u, now)
    return doc.tasks.filter((t) => !t.done && t.due && t.due >= start && (!end || t.due < end))
      .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority)
  }

  morningMessage(u, now = Date.now()) {
    const { style, name, today } = this.ctx(u, now)
    const list = this.todayList(u, now)
    this.remember(u, list.slice(0, MAX_LIST).map((t) => t.id))
    const late = list.filter((t) => t.due < today).length
    if (!list.length) return `${say(style, 'morning', { name })}\n${say(style, 'free')}`
    return [
      say(style, 'morning', { name }),
      `*${list.length}* thing${list.length === 1 ? '' : 's'} today${late ? ` (${late} overdue)` : ''}:`, '',
      ...this.numbered(list, today), list.length > MAX_LIST ? `…and ${list.length - MAX_LIST} more` : null, '',
      this.replyHint(u, '*td done 1* to tick one off'),
    ].filter((x) => x !== null).join('\n')
  }

  eveningMessage(u, now = Date.now()) {
    const { doc, tz, style, name, today } = this.ctx(u, now)
    const doneToday = doc.tasks.filter((t) => t.done && t.doneAt && todayIn(tz, t.doneAt) === today).length
    const days = streak(doc.tasks, tz, now)
    const left = this.todayList(u, now)
    this.remember(u, left.slice(0, MAX_LIST).map((t) => t.id))
    const head = [say(style, 'evening', { name }), `✅ *${doneToday}* done today${days > 1 ? ` · 🔥 ${days}-day streak` : ''}`]
    if (!left.length) return [...head, '', say(style, 'allclear')].join('\n')
    return [...head, '', `Still open (${left.length}):`, ...this.numbered(left, today), '',
      this.replyHint(u, '*td done 1* · *td move* to push the rest to tomorrow')].join('\n')
  }

  helpMessage(u) {
    return [
      '🤖 *Buddy commands* (start with *td*)', '',
      '• *td?* what’s due, including overdue',
      '• *td tomorrow* · *td upcoming* · *td overdue*',
      '• *td add* buy milk tomorrow 5pm',
      '• *td done 2* · *td start 2* · *td step 2*',
      '• *td snooze 2 1h*',
      '• *td move* push today’s leftovers to tomorrow',
      '• *td delete 2* · *td clear completed*',
      '• *td remind me to* call mum at 8pm',
      '• *td clear reminders* cancel reminders and delete my reminder messages',
      '• *td clear buddy* delete my recent messages', '',
      'Numbers refer to my last list. Dates: today, tomorrow, Mon, or a date. Times: 5pm or 17:00. Also *!3* priority, *#tag*, *@List*, and repeats like daily or every 2 weeks.', '',
      `_Buddy settings: ${this.brand} → Settings_`,
    ].join('\n')
  }

  // ----------------------------------------------------------- commands
  /** Which task "td done" / "td done 2" means, or an explanation. */
  target(u, code) {
    const s = this.st(u)
    const id = code ? s.codes?.[code] : s.last
    if (!id) return { error: code ? `There’s no #${code} on my last list. Send *td?* for a new one.` : 'Which one? Send *td?* for the list, then *td done 2*.' }
    const t = this.store.snapshot(u).tasks.find((x) => x.id === id)
    if (!t) return { error: 'That task is gone. Send *td?* for a new list.' }
    return { task: t }
  }
  changed(u, t) { try { this.onTaskChange(t) } catch {} return t }

  /**
   * A message from WhatsApp, with the "td" taken off. Returns { reply } if it was a
   * Buddy command, or null (then it's an ordinary "add a task").
   */
  command(u, body, now = Date.now()) {
    const text = String(body || '').trim()
    const low = text.toLowerCase()
    const { tz, style, today } = this.ctx(u, now)
    let m

    if (/^(help|h|commands|\?\?)$/.test(low)) return { reply: this.helpMessage(u) }

    const show = (label, list, hint = '_td done 1 · td start 2 · td snooze 3 2h_') => {
      this.remember(u, list.slice(0, MAX_LIST).map((t) => t.id))
      if (!list.length) return { reply: `📋 *${label}*: nothing open` }
      return { reply: [`📋 *${label}* (${list.length})`, ...this.numbered(list, today), list.length > MAX_LIST ? `…and ${list.length - MAX_LIST} more` : null, '', hint].filter((x) => x !== null).join('\n') }
    }

    if (/^(\?|today|list|)$/.test(low)) {
      return show('Today', this.todayList(u, now))
    }
    if (/^(tomorrow|tmr|besok)$/.test(low)) {
      return show('Tomorrow', this.dateList(u, addDaysKey(today, 1), addDaysKey(today, 2)))
    }
    if (/^(upcoming|next 7 days|next week)$/.test(low)) {
      return show('Next 7 days',this.dateList(u, today, addDaysKey(today, 8)))
    }
    if (/^overdue$/.test(low)) {
      return show('Overdue', this.store.snapshot(u).tasks.filter((t) => !t.done && t.due && t.due < today)
        .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority))
    }

    // Add a task directly from Buddy/self-chat: td add / td new / td todo / td task / td tambah
    if ((m = text.match(/^(?:add|new|todo|task|tambah)\s*:?\s+(.+)$/is))) {
      const doc = this.store.snapshot(u)
      const parsed = parseQuickAdd(m[1], doc.lists, today)
      if (!parsed.title) return { reply: 'Add what? e.g. *td add buy milk tomorrow 5pm*' }
      const { hints: _h, ...fields } = parsed
      if (fields.time && fields.remind === undefined) fields.remind = 0
      const task = this.store.addTask(u, fields)
      this.st(u).last = task.id
      this.saveState()
      const extras = [task.due && `${dayLabel(task.due, today)}${task.time ? `, ${time12(task.time)}` : ''}`, task.priority > 0 && `🚩 P${task.priority}`, task.tags?.length && task.tags.map((x) => `#${x}`).join(' ')].filter(Boolean)
      return { reply: `✅ Added: *${task.title}*${extras.length ? `\n${extras.join(' · ')}` : ''}` , task }
    }

    // done / start / step [n]
    if ((m = low.match(/^(done|finish(?:ed)?|selesai|start|started|step)(?:\s+#?(\d{1,2}))?$/))) {
      const { task, error } = this.target(u, m[2] && Number(m[2]))
      if (error) return { reply: error }
      const verb = m[1].startsWith('start') ? 'start' : m[1] === 'step' ? 'step' : 'done'
      if (verb === 'step') {
        const subtasks = task.subtasks || []
        const i = subtasks.findIndex((s) => !s.done)
        if (i < 0) return { reply: `☑ No steps left on *${task.title}*. *td done* to finish it.` }
        const nextSteps = subtasks.map((s, k) => (k === i ? { ...s, done: true } : s))
        this.changed(u, this.store.updateTask(u, task.id, { subtasks: nextSteps }))
        const left = nextSteps.filter((s) => !s.done)
        return { reply: left.length ? `☑ Ticked: _${subtasks[i].title}_\nNext: _${left[0].title}_ (${nextSteps.length - left.length}/${nextSteps.length})` : `☑ Last step done. *td done* to finish *${task.title}*.` }
      }
      if (task.done) return { reply: `✅ *${task.title}* is already done.` }
      if (verb === 'start') {
        this.changed(u, this.store.updateTask(u, task.id, { status: 'doing' }))
        return { reply: say(style, 'start', { title: task.title }) }
      }
      const saved = this.changed(u, this.store.updateTask(u, task.id, { status: 'done' }))
      const doc = this.store.snapshot(u)
      const doneToday = doc.tasks.filter((t) => t.done && t.doneAt && todayIn(tz, t.doneAt) === today).length
      const copy = saved.spawnedId && doc.tasks.find((t) => t.id === saved.spawnedId)
      if (copy) this.st(u).last = copy.id
      this.saveState()
      return { reply: [say(style, 'done', { title: task.title }), copy ? `🔁 Next one: ${dayLabel(copy.due, today)}` : null, style === 'short' ? null : `That’s ${doneToday} today.`].filter(Boolean).join('\n') }
    }

    // snooze [n] [when]
    if ((m = low.match(/^snooze(?:\s+#?(\d{1,2})(?=\s|$))?(?:\s+(.+))?$/))) {
      const { task, error } = this.target(u, m[1] && Number(m[1]))
      if (error) return { reply: error }
      const at = snoozeUntil(m[2], tz, now)
      if (!at) return { reply: 'I didn’t get when. Try *td snooze 30m*, *2h*, *tonight*, *tomorrow* or *3pm*.' }
      this.changed(u, this.store.updateTask(u, task.id, { wa: { at } }))
      return { reply: say(style, 'snooze', { when: whenText(at, tz, now) }) + `\n_${task.title}_` }
    }

    // move: today's unfinished (and overdue) tasks to tomorrow
    if (/^(move|move all)$/.test(low)) {
      const list = this.todayList(u, now)
      if (!list.length) return { reply: 'Nothing to move.' }
      const tomorrow = addDaysKey(today, 1)
      for (const t of list) this.changed(u, this.store.updateTask(u, t.id, { due: tomorrow }))
      return { reply: `➡️ Moved ${list.length} task${list.length === 1 ? '' : 's'} to tomorrow.` }
    }

    // delete/remove/cancel task [n]
    if ((m = low.match(/^(?:delete|remove|cancel)(?:\s+task)?(?:\s+#?(\d{1,2}))?$/))) {
      const { task, error } = this.target(u, m[1] && Number(m[1]))
      if (error) return { reply: error }
      const removed = this.store.deleteTask(u, task.id)
      this.changed(u, removed)
      const s = this.st(u)
      if (s.last === task.id) s.last = null
      for (const [k, id] of Object.entries(s.codes || {})) if (id === task.id) delete s.codes[k]
      this.saveState()
      return { reply: `🗑️ Removed *${task.title}*.` }
    }

    if (/^(?:clear|clean) completed$/.test(low)) {
      const r = this.store.clearCompleted(u)
      return { reply: r.removed ? `🧹 Cleared ${r.removed} completed task${r.removed === 1 ? '' : 's'}.` : 'Nothing completed to clear.' }
    }

    // Cancel all task-level WhatsApp reminders and clean the recent Buddy reminder messages.
    if (/^(?:clear|delete|remove) reminders?$/.test(low)) {
      const count = this.store.clearWaReminders(u)
      this.clearSent(u, ['reminder', 'nudge']).catch(() => {})
      return { reply: count ? `🧹 Cleared ${count} reminder${count === 1 ? '' : 's'} and deleting my recent reminder messages.` : '🧹 No reminders set. Deleting my recent reminder messages anyway.' }
    }

    if (/^(?:clear|delete|remove) (?:buddy|buddy messages|messages)$/.test(low)) {
      this.clearSent(u).catch(() => {})
      return { reply: '🧹 Deleting my recent messages.' }
    }

    // remind me (to) … : a task and a WhatsApp reminder
    if ((m = text.match(/^remind(?:\s+me)?(?:\s+to)?\s+(.+)$/i))) {
      const doc = this.store.snapshot(u)
      const parsed = parseQuickAdd(m[1], doc.lists, today)
      if (!parsed.title) return { reply: 'Remind you about what? e.g. *td remind me to call mum at 8pm*' }
      const { hints: _h, ...fields } = parsed
      if (fields.time && !fields.due) fields.due = today
      // "at 8pm" when it's already past 8pm means tomorrow
      if (fields.time && fields.due === today && zonedTime(today, fields.time, tz) <= now && !/\b(today|tonight|hari ini)\b/i.test(m[1])) fields.due = addDaysKey(today, 1)
      let wa
      if (fields.time) { wa = { before: 0 }; fields.remind = 0 }
      else if (fields.due && fields.due > today) wa = { at: zonedTime(fields.due, '09:00', tz) }
      else wa = { at: now + 3600e3 }
      const task = this.store.addTask(u, { ...fields, wa })
      const when = typeof wa.at === 'number' ? whenText(wa.at, tz, now) : whenText(zonedTime(task.due, task.time, tz), tz, now)
      this.st(u).last = task.id
      this.saveState()
      return { reply: `👌 I’ll remind you ${when}:\n*${task.title}*`, task }
    }
    return null
  }

  // ----------------------------------------------------------- the clock
  start(every = 30000) {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[buddy]', e)), every)
    this.timer.unref?.()
  }

  async tick(now = Date.now()) {
    if (!this.available) return
    for (const u of this.store.usernames()) {
      if (u === this.botUser) continue
      const doc = this.store.snapshot(u)
      const tz = doc.profile.tz || 'UTC'
      // tasks you asked Buddy to remind you about
      for (const t of doc.tasks) {
        if (t.done || !t.wa) continue
        const at = waInstant(t, tz)
        const sig = waSig(t)
        if (at === null || at > now || t.wa.sent === sig) continue
        this.store.setWaSent(u, t.id, sig) // first, so it never goes out twice
        if (now - at > LATE) continue
        try {
          await this.send(u, this.taskMessage(u, t, { now }), { kind: 'reminder' })
          this.remember(u, [t.id])
          console.log(`[buddy] ${u}: "${t.title}" → WhatsApp`)
        } catch (e) { console.warn(`[buddy] ${u}: ${e.message}`) }
      }
      // the morning brief and the evening check-in
      const b = this.settings(u)
      if (!b.on) continue
      const today = todayIn(tz, now)
      const s = this.st(u)
      for (const kind of ['morning', 'evening']) {
        if (!b[kind] || s[kind] === today) continue
        const at = zonedTime(today, b[kind], tz)
        if (now < at || now - at > BRIEF_WINDOW) continue
        s[kind] = today
        this.saveState()
        try {
          await this.send(u, kind === 'morning' ? this.morningMessage(u, now) : this.eveningMessage(u, now), { kind })
          console.log(`[buddy] ${u}: ${kind} message → WhatsApp`)
        } catch (e) { console.warn(`[buddy] ${u}: ${kind} failed: ${e.message}`) }
      }
    }
  }
}
