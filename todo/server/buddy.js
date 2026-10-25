import fs from 'node:fs'
import path from 'node:path'
import { zonedTime, todayIn } from './tz.js'
import { parseQuickAdd } from './quickadd.js'
import { dayLabel, dueText, time12 } from './whatsapp.js'
import { describeRepeat } from './repeat.js'
import { askBuddy } from './ai.js'

/**
 * WhatsApp Buddy 🤖: the todolist's bot in WhatsApp. It never guesses.
 *
 *  • Tap menus: under its messages Buddy puts a one-answer WhatsApp poll ("✅ Done",
 *    "😴 Snooze 1 hour", "📅 Move…"). A tap is exact, and works on iPhone, Android and Web.
 *  • Commands, Discord style: /today, /done K7, /move K7 fri 3pm, /help. A command that
 *    doesn't fit gets its exact usage back, never a guess. "td" still works for "/".
 *  • Every task has a short code (K7) that never changes, so a command can't hit the
 *    wrong task. Replying to Buddy's message about a task, or a tap, also says which one.
 *  • React 👍 to a reminder to tick it off.
 *  • Optional: the admin can give it a free Groq key. Then you can text it like a person
 *    ("when's the eartips thing?", "push maths to friday and tick off bio") and it answers;
 *    anything that changes a task still waits for your tap.
 *  • "yes" / "no" typed after a question works like tapping it; "thanks" gets a reply, "ok" a 👍.
 *
 * Buddy writes from the bot's number when the admin picked one and you chose it, else in
 * your own "Message yourself" chat (where commands need the "/", since you also write notes there).
 */

/** Two ways Buddy writes: 'friendly' is shown as Long, 'short' as Short. (Old 'coach' settings read as Long.) */
export const STYLES = ['friendly', 'short']

/** The same message for the bot's chat. (Old texts said *td done*; there it's just *done*.) */
export const plain = (text) => String(text)
  .replace(/ \(start with \*td\*\)/g, ' (just reply here)')
  .replace(/\*td:\*/g, '*add*')
  .replace(/(?<![a-z/])td\?/gi, 'today')
  .replace(/(?<![a-z/])td:\s?/gi, 'add ')
  .replace(/(?<![a-z/])td (?=[a-z])/gi, '')
export const BUDDY_DEFAULTS = { on: false, style: 'friendly', morning: '07:30', evening: '21:00', via: 'self', viaChosen: false, exams: true, examsAt: '20:00', study: null, studyBlocks: true }
const LATE = 12 * 3600e3 // a reminder missed by more than this (server was down) is skipped
const BRIEF_WINDOW = 3 * 3600e3 // a morning/evening message more than 3h late isn't sent
const MAX_LIST = 11 // tasks on a list (a poll takes 12 options: the tasks and "➕ Add a task")
const MENU_TTL = 7 * 24 * 3600e3 // a tap on a menu older than a week does nothing
const FLOW_TTL = { bot: 10 * 60e3, self: 5 * 60e3 } // how long Buddy waits for a typed answer
const LAST_TTL = 2 * 3600e3 // "/done" with no code means the task Buddy last wrote about, for this long
const AI_READ_ONLY = new Set(['today', 'tomorrow', 'week', 'overdue', 'task', 'study', 'exams', 'help', 'menu'])
const AI_ALLOWED = new Set([...AI_READ_ONLY, 'add', 'done', 'start', 'step', 'snooze', 'move', 'rename', 'delete', 'undo'])
const TALK_TTL = 30 * 60e3 // the AI sees the chat's last few messages from this long ago
const TYPED_TTL = 15 * 60e3 // "yes" typed this soon after a question answers it
const DONE_EMOJI = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '✅', '✔️', '☑️', '👌', '👌🏻', '👌🏼', '👌🏽', '👌🏾', '👌🏿'])
// Small talk Buddy answers by itself (no AI needed): "thanks" gets a reply, "ok" / "bet" a 👍.
const THANKS = /\b(thanks?|thank ?you|thx|thnx|tq|ty|tysm|makasih|terima ?kasih|appreciate)/i
const CHAT_WORDS = new Set(('ok okay oke okey okie okk k kk kay sip siap mantap nice cool great noted alright alr aight ight bet gotcha got it ' +
  'sure yep yup ya yeah yea yes lol haha hahaha hehe wkwk wkwkwk np no problem good sounds perfect awesome will do roger fine ah oh i see oic mhm ' +
  'thats that is so much very you thank thanks thx thnx tq ty tysm makasih terima kasih banyak bro sis buddy man dude lah la sia bestie appreciate ' +
  'it a lot love ur the best amazing legend nice one sweet ok lah okie dokie cheers ta').split(' '))
/** 'thanks', 'ack' (ok, bet, 👍) or null (something else). */
export function smallTalk(text) {
  const t = String(text || '').toLowerCase()
  const words = t.replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)
  if (!words.length) return /\p{Extended_Pictographic}/u.test(t) ? 'ack' : null // just emoji
  if (words.length > 8 || !words.every((w) => CHAT_WORDS.has(w))) return null
  if (words.length === 1 && /^(no|yes|ya|yeah|yea|yep|yup|sure|it|i|a|is|so|that)$/.test(words[0])) return null // an answer to something, not small talk
  return THANKS.test(t) ? 'thanks' : 'ack'
}
const YES = /^(y|ya|yah|yes|yess|yep|yup|yeah|yea|sure|ok|okay|oke|okie|k|kk|do it|go|go ahead|confirm|yes please|pls|please|iya|iyaa|betul|boleh|sip|gas|👍|✅|👌)[\s.!]*$/iu
const NO = /^(n|no|nope|nah|nahh|no thanks|cancel|dont|don't|do not|tidak|ngga|nggak|gak|ga|enggak|jangan|tak|❌|👎)[\s.!]*$/iu
const normLabel = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
const THANKS_BACK = ['Anytime! 🙌', 'You got it 😊', 'No problem!', 'Anytime, {name}!', 'Happy to help 🙂']

// ------------------------------------------------------------------ voices
const VOICE = {
  // "Long": the full picture (when it's due, steps, notes), in plain words
  friendly: {
    hello: ['Hi {name}', 'Hey {name}'],
    nudge: ['Reminder:', 'Don’t forget:', 'Coming up:'],
    done: ['✅ Done: *{title}*', '✅ *{title}* ticked off'],
    start: ['▶️ Started *{title}*'],
    snooze: ['😴 Okay, I’ll remind you again {when}.', '😴 Snoozed. Back {when}.'],
    morning: ['☀️ Morning {name}', '☀️ Good morning {name}'],
    evening: ['🌙 Evening {name}', '🌙 Hi {name}, here’s how today went'],
    free: ['Nothing due today.'],
    allclear: ['Everything for today is done.', 'All done for today.'],
  },
  // "Short": one line
  short: {
    hello: [''], nudge: [''],
    done: ['✅ {title}'], start: ['▶️ {title}'], snooze: ['😴 {when}'],
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
const weekdayOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
const ago = (min) => (min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`)
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s))
const lower1 = (s) => s.replace(/^(Today|Tomorrow|Tonight|Yesterday)/, (x) => x.toLowerCase())

/** "in 25 min", "now", "2 h late", "tomorrow" … for the due line. */
function dueLine(t, tz, now) {
  if (!t.due) return null
  const today = todayIn(tz, now)
  const label = dueText(t, today)
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
  const w = String(when || '').trim().toLowerCase().replace(/^(for|in|until|till|at)\s+/, '')
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

// -------------------------------------------------------------- task codes
// Letter + digit (K7), without look-alikes (I, L, O, 0, 1). 184 of them, then K72 etc.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_DIGITS = '23456789'
export const CODE_RE = /^[a-hj-km-np-z][2-9]\d?$/i

// ---------------------------------------------------------------- commands
/**
 * Every command, Discord style: its name, other names, how to write it, and what it does.
 * `task`: it works on one task (a code, a list number, or the task you replied to / Buddy last wrote about).
 */
export const COMMANDS = [
  { name: 'today', aliases: ['?', 'list', 'td?'], usage: '/today', about: 'What’s due today, and anything overdue', group: 'Your tasks' },
  { name: 'tomorrow', aliases: ['tmr', 'besok'], usage: '/tomorrow', about: 'What’s due tomorrow', group: 'Your tasks' },
  { name: 'week', aliases: ['upcoming', 'next'], usage: '/week', about: 'The next 7 days', group: 'Your tasks' },
  { name: 'overdue', aliases: ['late'], usage: '/overdue', about: 'Everything that’s late', group: 'Your tasks' },
  { name: 'task', aliases: ['open', 'show'], usage: '/task <code>', about: 'One task, with its menu', example: '/task K7', task: true, group: 'Your tasks' },
  { name: 'add', aliases: ['new', 'tambah', 'todo', 'remind'], usage: '/add <task> [day] [time]', about: 'Add a task. With a day or time, I also WhatsApp you then', example: '/add buy milk tomorrow 5pm', group: 'Change tasks' },
  { name: 'done', aliases: ['finish', 'finished', 'selesai'], usage: '/done [code]', about: 'Tick it off', example: '/done K7', task: true, group: 'Change tasks' },
  { name: 'start', aliases: ['started', 'mulai'], usage: '/start [code]', about: 'Mark it in progress', example: '/start K7', task: true, group: 'Change tasks' },
  { name: 'step', aliases: ['nextstep'], usage: '/step [code]', about: 'Tick its next step', example: '/step K7', task: true, group: 'Change tasks' },
  { name: 'snooze', aliases: ['later'], usage: '/snooze [code] [when]', about: 'WhatsApp me about it again later (1 hour if you don’t say)', example: '/snooze K7 30m', task: true, group: 'Change tasks' },
  { name: 'move', aliases: ['reschedule', 'pindah', 'push'], usage: '/move [code] <day and/or time>', about: 'Change its day or time', example: '/move K7 fri 3pm', task: true, group: 'Change tasks' },
  { name: 'rename', aliases: ['name'], usage: '/rename [code] <new name>', about: 'Change its name', example: '/rename K7 Read 2 chapters', task: true, group: 'Change tasks' },
  { name: 'delete', aliases: ['remove', 'hapus'], usage: '/delete [code]', about: 'Delete it (I ask first)', example: '/delete K7', task: true, group: 'Change tasks' },
  { name: 'undo', aliases: ['restore'], usage: '/undo', about: 'Bring back the task you last deleted', group: 'Change tasks' },
  { name: 'study', aliases: ['belajar', 'plan'], usage: '/study [tomorrow]', about: 'Your study plan', group: 'Study' },
  { name: 'topic', aliases: ['tick', 'studied', 'centang'], usage: '/topic <number>', about: 'Tick a study topic off (the number from /study)', example: '/topic 2', group: 'Study' },
  { name: 'exams', aliases: ['exam', 'ujian'], usage: '/exams', about: 'Your next exams', group: 'Study' },
  { name: 'clear', usage: '/clear completed | reminders | messages', about: 'Tidy up: finished tasks, all WhatsApp reminders, or my recent messages', example: '/clear completed', group: 'Other' },
  { name: 'menu', aliases: ['hi', 'hello', 'hey', 'halo', 'hai', 'yo', 'start-menu'], usage: '/menu', about: 'The main menu', group: 'Other' },
  { name: 'cancel', aliases: ['stop', 'batal'], usage: '/cancel', about: 'Stop what I’m waiting for', group: 'Other' },
  { name: 'help', aliases: ['commands', 'h', '??'], usage: '/help [command]', about: 'This list, or one command in detail', example: '/help move', group: 'Other' },
  { name: 'test', usage: '/test', about: 'Check that tap menus work', hidden: true },
]
const BY_NAME = new Map()
for (const c of COMMANDS) for (const n of [c.name, ...(c.aliases || [])]) BY_NAME.set(n, c)

/** The closest command name (for "/dne" → "/done"). */
function closest(word) {
  let best = null, score = 99
  for (const n of BY_NAME.keys()) {
    if (n.length < 3) continue
    const d = editDistance(word, n)
    if (d < score) { score = d; best = BY_NAME.get(n).name }
  }
  return score <= 2 ? best : null
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

/**
 * A message → { cmd, args } (a command), { unknown } (a "/word" that isn't one), or null (not
 * for Buddy). In "Message yourself" only "/…" or "td …" count, since you write notes there;
 * in the bot's chat the "/" is optional.
 */
export function parseCommand(text, chat = 'bot') {
  let t = String(text || '').trim()
  let prefixed = false
  const td = t.match(/^td(?=$|[\s:?])\s*/i)
  if (t.startsWith('/')) { t = t.slice(1).trimStart(); prefixed = true }
  else if (td) {
    prefixed = true
    t = t.slice(td[0].length)
    if (/^\?\s*$/.test(t)) t = 'today'
    else if (t.startsWith(':')) t = `add ${t.slice(1).trim()}`
  }
  if (!prefixed && chat !== 'bot') return null
  t = t.replace(/[.!]+$/, '').trim()
  if (!t) return prefixed ? { cmd: BY_NAME.get('menu'), args: '' } : null
  const word = t.split(/\s+/)[0]
  const cmd = BY_NAME.get(word.toLowerCase())
  if (!cmd) return prefixed ? { unknown: word } : null
  return { cmd, args: t.slice(word.length).trim(), prefixed }
}

// ------------------------------------------------------------- the buddy
export class Buddy {
  /**
   * `onTaskChange(task)` is called after Buddy changes a task (so e.g. the admin's progress view
   * updates when you finish a task they gave you). `ai()` → { key, model } or null (the admin's Groq key).
   */
  constructor(dataDir, store, link, { brand = 'your todolist', onTaskChange = () => {}, getBot = () => String(process.env.BOT_USER || process.env.WA_BOT_USER || '').trim().toLowerCase() || null, planner = null, nameOf = null, ai = () => null, propose = askBuddy } = {}) {
    this.store = store
    this.link = link
    this.brand = brand
    this.onTaskChange = onTaskChange
    this.file = path.join(dataDir, 'buddy.json')
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.state = {} }
    this.phones = new Map() // username → { jid, at } (for the bot number)
    this.getBot = getBot // () => the bot account's username, or null
    this.planner = planner // { study, exams }: the study planner and the exam timetables
    this.nameOf = nameOf // (u) => their name (the profile's, or their Whats Up account's)
    this.aiConfig = ai
    this.propose = propose
    this.recentTaps = new Map() // a tap reported twice (two ways WhatsApp delivers votes) only counts once
    this.outgoing = new Map() // "session|text" of messages Buddy is sending right now
  }

  saveState() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state))
    fs.renameSync(tmp, this.file)
  }
  st(u) {
    const out = (this.state[u] ||= {})
    out.tc ||= {} // task codes: code → task id
    out.list ||= [] // the task ids on Buddy's last list, in order ("/done 2")
    out.sent ||= []
    out.byMsg ||= {}
    out.menus ||= {}
    return out
  }

  settings(u) {
    const b = { ...BUDDY_DEFAULTS, ...(this.store.snapshot(u).profile.buddy || {}) }
    return STYLES.includes(b.style) ? b : { ...b, style: 'friendly' }
  }
  get botUser() { return this.getBot() || null }
  /** Does Buddy write to this person from the bot number? They can pick "Message yourself" instead. */
  viaBot(u) { const b = this.settings(u); return !!this.botUser && this.botUser !== u && b.via === 'bot' && !!b.viaChosen }
  /** Is Buddy usable at all right now (link set up, admin hasn't switched it off)? */
  get available() { return !!this.link?.enabled('reminders') && this.link.settings().whatsapp.buddy !== false }
  /** The admin's AI (a Groq key), when it's set and switched on. */
  get ai() { try { const a = this.aiConfig?.(); return a?.key ? a : null } catch { return null } }

  // ----------------------------------------------------------- task codes
  /** A task's short code (K7), made the first time Buddy shows it. */
  codeOf(u, task) {
    const s = this.st(u)
    for (const [c, id] of Object.entries(s.tc)) if (id === task.id) return c
    const taken = new Set(Object.keys(s.tc))
    if (taken.size > 150) this.pruneCodes(u)
    let code = null
    for (let i = 0; i < 400 && !code; i++) {
      const c = CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)] + CODE_DIGITS[Math.floor(Math.random() * CODE_DIGITS.length)] + (i > 200 ? CODE_DIGITS[i % 8] : '')
      if (!taken.has(c)) code = c
    }
    s.tc[code] = task.id
    this.saveState()
    return code
  }
  /** The task behind a code (null: no such code, or the task is gone). */
  taskOfCode(u, code) {
    const id = this.st(u).tc[String(code || '').toUpperCase()]
    return id ? this.store.snapshot(u).tasks.find((t) => t.id === id) || null : null
  }
  /** Forget codes of tasks that are gone, or done for over a week (they can be used again). */
  pruneCodes(u) {
    const s = this.st(u)
    const tasks = new Map(this.store.snapshot(u).tasks.map((t) => [t.id, t]))
    for (const [c, id] of Object.entries(s.tc)) {
      const t = tasks.get(id)
      if (!t || (t.done && Date.now() - (t.doneAt || 0) > 7 * 864e5)) delete s.tc[c]
    }
  }
  taskById(u, id) { return id ? this.store.snapshot(u).tasks.find((t) => t.id === id) || null : null }

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
  /** Which person a WhatsApp number belongs to (for messages to the bot). */
  async userOfJid(jid, people) {
    for (const u of people) if (u !== this.botUser && (await this.jidOf(u)) === jid) return u
    return null
  }
  /** Where to write: the chat they wrote in (`channel`), else the bot's chat if they chose it (falling back to their own). */
  async routes(u, channel) {
    if (channel) return [channel]
    const out = []
    if (this.viaBot(u)) { const jid = await this.jidOf(u); if (jid) out.push({ session: this.botUser, jid }) }
    out.push({ session: u })
    return out
  }
  /** One message out. `about`: { task } or { list } it is about (so a reply, a tap or a 👍 means them). */
  async post(u, item, channel = null) {
    let last
    for (const ch of await this.routes(u, channel)) {
      try {
        const viaBot = ch.session === this.botUser
        const to = { username: ch.session, ...(ch.jid ? { jid: ch.jid } : {}) }
        let result
        if (item.react) {
          if (!item.to) return null
          await this.link.call('react', { ...to, jid: ch.jid || item.jid, id: item.to, emoji: item.react })
          return null
        }
        if (item.menu) {
          result = await this.link.call('poll', { ...to, name: cut(viaBot ? plain(item.menu.title) : item.menu.title, 250), options: item.menu.options })
          if (result?.id) {
            const s = this.st(u)
            const keep = Object.entries(s.menus).filter(([, m]) => Date.now() - m.at < MENU_TTL).slice(-120)
            s.menus = { ...Object.fromEntries(keep), [result.id]: { options: item.menu.options, values: item.menu.values, meta: item.menu.meta || {}, at: Date.now() } }
          }
        } else {
          const text = viaBot ? plain(item.text) : item.text
          // in "Message yourself" Buddy's message comes straight back as one of yours: know it's ours
          const mark = `${ch.session}|${text}`
          this.outgoing.set(mark, Date.now())
          try { result = await this.link.call('send', { ...to, text }) } finally { setTimeout(() => this.outgoing.delete(mark), 10e3).unref?.() }
        }
        this.trackSent(u, result, { session: ch.session, jid: result?.jid || ch.jid, kind: item.kind || (item.menu ? 'menu' : 'buddy'), about: item.about })
        return result
      } catch (e) {
        last = e
        if (ch.session === this.botUser && !channel) console.warn(`[buddy] bot couldn't write to ${u} (${e.message}); using their "Message yourself" chat`)
      }
    }
    throw last || new Error('Couldn’t send')
  }
  async deliver(u, items, channel = null) {
    const out = []
    for (const it of items || []) if (it) out.push(await this.post(u, it, channel))
    return out
  }
  trackSent(u, result, { session, jid, kind = 'buddy', about = null } = {}) {
    if (!result?.id || !session) return result
    const s = this.st(u)
    const cutoff = Date.now() - 60 * 3600e3
    s.sent = [...s.sent, { session, jid, id: result.id, at: Date.now(), kind }].filter((x) => x.at >= cutoff).slice(-150)
    this.noteMsg(u, result.id, about) // also saves
    return result
  }
  /** What a message Buddy sent was about, by its WhatsApp id. It also becomes what Buddy is "on". */
  noteMsg(u, id, about = null) {
    if (!id) return
    const s = this.st(u)
    if (about?.task) { s.last = about.task; s.lastAt = Date.now() }
    if (about?.list) s.list = about.list
    s.byMsg[id] = { task: about?.task || null, list: about?.list || null, at: Date.now() }
    const cutoff = Date.now() - 14 * 86400e3
    const keep = Object.entries(s.byMsg).filter(([, v]) => v.at >= cutoff).sort((a, b) => a[1].at - b[1].at).slice(-300)
    s.byMsg = Object.fromEntries(keep)
    this.saveState()
  }
  /** One of this person's menus (null: not one of Buddy's, or too old to act on). */
  menuOf(u, pollId) {
    const m = this.state[u]?.menus?.[pollId]
    return m && Date.now() - m.at < MENU_TTL ? m : null
  }
  /** Is this text one Buddy is sending into this account's own chat right now? */
  isOwnText(session, text) { return this.outgoing.has(`${session}|${text}`) }
  /** Did Buddy send this message (to this person)? */
  sentByBuddy(u, id) { return !!this.state[u]?.byMsg?.[id] }
  /** A plain message (reminders.js and the todolist's test button use this). `tasks`: what it is about. */
  async send(u, text, { kind = 'buddy', tasks = null } = {}) {
    const about = tasks?.length === 1 ? { task: tasks[0] } : tasks?.length ? { list: tasks } : null
    return this.post(u, { text, kind, about })
  }
  /** A task's card and its menu (reminders, a task someone gave you, a nudge). */
  async sendTask(u, task, { head = null, kind = 'reminder', now = Date.now() } = {}) {
    return this.deliver(u, this.taskItems(u, task, { head, kind, now }))
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

  // ----------------------------------------------------------- messages
  ctx(u, now = Date.now()) {
    const doc = this.store.snapshot(u)
    const tz = doc.profile.tz || 'UTC'
    const b = this.settings(u)
    return { doc, tz, style: b.style, name: (doc.profile.name || this.nameOf?.(u) || u).split(' ')[0], now, today: todayIn(tz, now) }
  }
  /** "/" in the person's own chat; nothing needed in the bot's chat. */
  slash(u) { return this.viaBot(u) ? '' : '/' }

  /** The message about one task: its card. */
  taskMessage(u, t, { why = 'wa', head = null, now = Date.now() } = {}) {
    const { doc, tz, style, name } = this.ctx(u, now)
    const due = dueLine(t, tz, now)
    const list = t.listId && doc.lists.find((l) => l.id === t.listId)
    const steps = t.subtasks || []
    const next = steps.find((s) => !s.done)
    const code = this.codeOf(u, t)
    if (style === 'short') return [`⏰ *${t.title}* · ${code}${due ? `\n${due}` : ''}`, next ? `next: ${next.title}` : null].filter(Boolean).join('\n')
    const lines = [head ?? `${say(style, 'hello', { name })}, ${why === 'assigned' ? 'someone gave you a task.' : say(style, 'nudge').toLowerCase().replace(/:$/, '…')}`, '', `📝 *${t.title}* · ${code}`]
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
    return lines.join('\n')
  }
  /** A task's card, then its tap menu. */
  taskItems(u, t, { head = null, kind = 'buddy', now = Date.now() } = {}) {
    return [{ text: this.taskMessage(u, t, { head, now }), kind, about: { task: t.id } }, this.taskMenu(u, t, kind)]
  }
  /** What you can do with a task, as a tap menu. Short options: they show in full on an iPhone. */
  taskMenu(u, t, kind = 'menu') {
    const code = this.codeOf(u, t)
    const steps = (t.subtasks || []).filter((s) => !s.done)
    const items = t.done
      ? [['↩️ Not done after all', 'undone']]
      : [
          ['✅ Done', 'done'],
          t.status !== 'doing' && ['▶️ Start', 'start'],
          steps.length && ['☑️ Tick next step', 'step'],
          ['😴 Snooze 1 hour', 'snooze1h'],
          ['⏰ Snooze until…', 'snoozeMenu'],
          ['📅 Move…', 'moveMenu'],
          ['💬 My reminder…', 'waMenu'],
          ['✏️ Rename…', 'rename'],
          ['🗑 Delete…', 'delete'],
        ].filter(Boolean)
    return this.menu(`${cut(t.title, 60)} (${code}): what now?`, items, { kind: 'task', task: t.id }, kind, { task: t.id })
  }
  /** A tap menu item: [label, value] pairs, plus what it's for. */
  menu(title, pairs, meta, kind = 'menu', about = null) {
    const seen = new Set()
    const ok = pairs.filter(([l]) => l && !seen.has(l) && seen.add(l)).slice(0, 12)
    return { menu: { title, options: ok.map(([l]) => cut(l, 100)), values: ok.map(([, v]) => v), meta }, kind, about }
  }

  /** Today's open tasks (overdue first). */
  todayList(u, now = Date.now()) {
    const { doc, today } = this.ctx(u, now)
    return doc.tasks.filter((t) => !t.done && t.due && t.due <= today)
      .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority)
  }
  /** Tasks with a due date in [start, end), keeping the same order as today's list. */
  dateList(u, start, end, now = Date.now()) {
    const { doc } = this.ctx(u, now)
    return doc.tasks.filter((t) => !t.done && t.due && t.due >= start && (!end || t.due < end))
      .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority)
  }
  numbered(u, tasks, today, { days = false } = {}) {
    return tasks.slice(0, MAX_LIST).map((t, i) => {
      const when = t.due < today ? ` _(${dayLabel(t.due, today).toLowerCase()})_` : days && t.due !== today ? ` · ${dayLabel(t.due, today)}${t.time ? ` ${time12(t.time)}` : ''}` : t.time ? ` · ${time12(t.time)}` : ''
      return `${i + 1}. ${t.due < today ? '⚠️' : t.status === 'doing' ? '◐' : '○'} ${t.title}${when} · ${this.codeOf(u, t)}`
    })
  }
  /** A list as a message, then "tap a task to open it". */
  listItems(u, label, list, { now = Date.now(), days = false, empty = null } = {}) {
    const { today } = this.ctx(u, now)
    const ids = list.slice(0, MAX_LIST).map((t) => t.id)
    if (!list.length) return [{ text: empty || `📋 *${label}*: nothing open.`, about: { list: [] } }]
    const text = [`📋 *${label}* (${list.length})`, ...this.numbered(u, list, today, { days }), list.length > MAX_LIST ? `…and ${list.length - MAX_LIST} more` : null].filter((x) => x !== null).join('\n')
    return [
      { text, about: { list: ids } },
      this.menu('Tap a task to open it', [...list.slice(0, MAX_LIST).map((t) => [`${this.codeOf(u, t)} · ${cut(t.title, 40)}`, `open:${t.id}`]), ['➕ Add a task', 'add']], { kind: 'list' }, 'menu', { list: ids }),
    ]
  }

  morningMessage(u, now = Date.now()) {
    const { style, name, today } = this.ctx(u, now)
    const list = this.todayList(u, now)
    const late = list.filter((t) => t.due < today).length
    const extra = this.plannerLines(u, today)
    if (!list.length) return [`${say(style, 'morning', { name })}\n${say(style, 'free')}`, ...(extra.length ? ['', ...extra] : [])].join('\n')
    return [
      say(style, 'morning', { name }),
      `*${list.length}* thing${list.length === 1 ? '' : 's'} today${late ? ` (${late} overdue)` : ''}:`, '',
      ...this.numbered(u, list, today), list.length > MAX_LIST ? `…and ${list.length - MAX_LIST} more` : null,
      ...(extra.length ? ['', ...extra] : []),
    ].filter((x) => x !== null).join('\n')
  }
  morningItems(u, now = Date.now()) {
    const list = this.todayList(u, now)
    const ids = list.slice(0, MAX_LIST).map((t) => t.id)
    return [{ text: this.morningMessage(u, now), kind: 'morning', about: { list: ids } }, list.length ? this.menu('Tap a task to open it', [...list.slice(0, MAX_LIST).map((t) => [`${this.codeOf(u, t)} · ${cut(t.title, 40)}`, `open:${t.id}`]), ['➕ Add a task', 'add']], { kind: 'list' }, 'morning', { list: ids }) : null]
  }

  eveningMessage(u, now = Date.now()) {
    const { doc, tz, style, name, today } = this.ctx(u, now)
    const doneToday = doc.tasks.filter((t) => t.done && t.doneAt && todayIn(tz, t.doneAt) === today).length
    const days = streak(doc.tasks, tz, now)
    const left = this.todayList(u, now)
    const head = [say(style, 'evening', { name }), `✅ *${doneToday}* done today${days > 1 ? ` · 🔥 ${days}-day streak` : ''}`]
    if (!left.length) return [...head, '', say(style, 'allclear')].join('\n')
    return [...head, '', `Still open (${left.length}):`, ...this.numbered(u, left, today)].join('\n')
  }
  eveningItems(u, now = Date.now()) {
    const left = this.todayList(u, now)
    const ids = left.slice(0, MAX_LIST).map((t) => t.id)
    return [{ text: this.eveningMessage(u, now), kind: 'evening', about: { list: ids } }, left.length ? this.menu('Tap a task, or move them all', [['➡️ Move all to tomorrow', 'moveAll'], ...left.slice(0, MAX_LIST).map((t) => [`${this.codeOf(u, t)} · ${cut(t.title, 40)}`, `open:${t.id}`])], { kind: 'list' }, 'evening', { list: ids }) : null]
  }

  /** /help, Discord style: every command, or one in detail. */
  helpMessage(u, about = '') {
    const s = this.slash(u)
    const one = about && BY_NAME.get(about.replace(/^\//, '').toLowerCase())
    if (one) {
      return [`🤖 *${s}${one.name}*`, one.about, '', `Usage: \`${s}${one.usage.replace(/^\//, '')}\``, one.example ? `Example: \`${s}${one.example.replace(/^\//, '')}\`` : null,
        one.aliases?.length ? `Also: ${one.aliases.filter((a) => /^[a-z]/.test(a)).map((a) => s + a).join(', ')}` : null,
        one.task ? `\nWithout a code it means the task you replied to, or the one I just wrote about.` : null].filter((x) => x !== null).join('\n')
    }
    const groups = []
    for (const c of COMMANDS.filter((x) => !x.hidden)) {
      let g = groups.find((x) => x.name === c.group)
      if (!g) groups.push((g = { name: c.group, lines: [] }))
      g.lines.push(`${s}${c.usage.replace(/^\//, '')}\n   _${c.about}_`)
    }
    return [
      '🤖 *Buddy commands*',
      s ? 'In this chat, start commands with */* (or *td*).' : 'Type a command, or tap the menus under my messages.',
      ...groups.flatMap((g) => ['', `*${g.name}*`, ...g.lines]),
      '',
      'Every task has a code like *K7*. Reply to my message about a task and you can leave the code out.',
      'React 👍 to a reminder to tick it off.',
      '',
      '⏰ *Quick reminders* (not tasks): *-reminder 30m* buy milk · *-reminders* · *-cancel 2*',
      `_Buddy settings: ${this.brand} → Settings_`,
    ].join('\n')
  }
  mainMenu(extra = []) {
    return this.menu('What do you want to do?', [...extra, ['📋 Today', 'cmd:today'], ['📅 Tomorrow', 'cmd:tomorrow'], ['🗓 Next 7 days', 'cmd:week'], ['⚠️ Overdue', 'cmd:overdue'], ['➕ Add a task', 'add'], ['📚 Study plan', 'cmd:study'], ['📝 Exams', 'cmd:exams'], ['❓ All commands', 'cmd:help']], { kind: 'main' })
  }

  // ----------------------------------------------- exams + study planner
  examsOn(u, date) {
    return (this.planner?.exams?.examsFor(u) || []).filter((e) => e.date === date).sort((a, b) => (a.start || '').localeCompare(b.start || ''))
  }
  examsFrom(u, from, days) {
    const to = addDaysKey(from, days)
    return (this.planner?.exams?.examsFor(u) || []).filter((e) => e.date >= from && e.date < to)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''))
  }
  examLine(e, today) {
    const end = e.start && e.minutes ? (() => { const [h, m] = e.start.split(':').map(Number); const t = h * 60 + m + e.minutes; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` })() : null
    const when = e.start ? `${time12(e.start)}${end ? `–${time12(end)}` : ''}` : ''
    return `📝 *${e.subject}${e.paper ? ` ${e.paper}` : ''}*${today && e.date !== today ? ` · ${dayLabel(e.date, today)}` : ''}${when ? ` · ${when}` : ''}${e.venue ? ` · ${e.venue}` : ''}`
  }
  examMessage(u, list, now = Date.now()) {
    const { style, name } = this.ctx(u, now)
    if (style === 'short') return [`📝 Exam${list.length > 1 ? 's' : ''} tomorrow`, ...list.map((e) => this.examLine(e))].join('\n')
    return [`${say(style, 'hello', { name })}, exam${list.length > 1 ? 's' : ''} tomorrow:`, '', ...list.map((e) => this.examLine(e)), '', 'Pack what you need tonight and get some sleep. Good luck! 🍀'].join('\n')
  }
  upcomingExams(u, now = Date.now()) {
    const { today } = this.ctx(u, now)
    const list = this.examsFrom(u, today, 21)
    if (!list.length) return '📝 No exams in the next 3 weeks.'
    return [`📝 *Your next exams* (${list.length})`, ...list.slice(0, 15).map((e) => this.examLine(e, today)), list.length > 15 ? `…and ${list.length - 15} more` : null].filter(Boolean).join('\n')
  }

  plan(u) { try { return this.planner?.study?.get(u) || null } catch { return null } }
  studyBlocks(u, date) {
    const p = this.plan(u)
    if (!p) return []
    return p.blocks.filter((b) => b.date === date).sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || a.order - b.order)
  }
  blockDone(b) { return b.topics.length ? b.topics.every((t) => t.done) : b.done }
  /**
   * One study block: its topics as bullets, each with its number for "/topic 2" in brackets
   * at the end. The numbers run on through the whole message (so every topic has its own).
   */
  blockLines(u, b, codes) {
    const p = this.plan(u)
    const s = p?.subjects.find((x) => x.id === b.subject)
    const tags = (b.tags || []).map((id) => p?.tags?.find((t) => t.id === id)?.name).filter(Boolean)
    const head = `${s?.priority ? '🔴 ' : ''}*${s?.name || 'Study'}*${b.mode ? ` · ${b.mode}` : ''}${b.time ? ` · ${time12(b.time)}` : ''}${b.minutes ? ` · ${b.minutes} min` : ''}${tags.length ? ` · ${tags.map((t) => `#${t}`).join(' ')}` : ''}`
    const lines = [head]
    const items = b.topics.length ? b.topics : [null]
    for (const t of items) {
      codes.push([b.date, b.id, t ? t.id : null])
      const done = t ? t.done : b.done
      const text = t ? t.text : 'the whole block'
      lines.push(`• ${done ? `~${text}~ ✓` : text} (${codes.length})`)
    }
    if (b.note) lines.push(`_${b.note}_`)
    return lines
  }
  studyMessage(u, date, now = Date.now()) {
    const { style, name, today } = this.ctx(u, now)
    const p = this.plan(u)
    const blocks = this.studyBlocks(u, date)
    const when = date === today ? 'today' : dayLabel(date, today).toLowerCase()
    if (!blocks.length) return p?.days?.[date] === 'rest' ? `🌿 Rest day ${when}. Nothing planned.` : `📚 Nothing in your study planner for ${when}.`
    const codes = []
    const lines = blocks.flatMap((b, i) => [...(i ? [''] : []), ...this.blockLines(u, b, codes)]) // a blank line between subjects
    this.st(u).studyCodes = codes
    this.saveState()
    const head = style === 'short' ? `📚 Study ${when}` : `📚 ${say(style, 'hello', { name })}, here’s your study plan for ${when}:`
    const exams = this.examsOn(u, date)
    return [head, ...(exams.length ? ['', ...exams.map((e) => this.examLine(e))] : []), '', ...lines].join('\n')
  }
  /** The study plan, then "tap a topic when you've done it" (topics not done yet, up to 12). */
  studyItems(u, date, now = Date.now(), { kind = 'study' } = {}) {
    const text = this.studyMessage(u, date, now)
    const codes = this.st(u).studyCodes || []
    return [{ text, kind }, this.topicMenu(u, codes, kind)]
  }
  topicMenu(u, codes, kind = 'study') {
    const p = this.plan(u)
    if (!p || !codes.length) return null
    const open = []
    codes.forEach(([date, bid, tid], i) => {
      const b = p.blocks.find((x) => x.id === bid && x.date === date)
      if (!b) return
      const t = tid ? b.topics.find((x) => x.id === tid) : null
      if (tid ? !t || t.done : b.done) return
      const subject = p.subjects.find((x) => x.id === b.subject)?.name || 'Study'
      open.push([`${i + 1}. ${cut(t ? t.text : `${subject} (whole block)`, 45)}`, `topic:${i + 1}`])
    })
    if (!open.length) return null
    return this.menu('Tap a topic when you’ve done it', open.slice(0, 12), { kind: 'study', codes }, kind)
  }
  blockMessage(u, b, now = Date.now()) {
    const { style, name } = this.ctx(u, now)
    const codes = []
    const lines = this.blockLines(u, b, codes)
    this.st(u).studyCodes = codes
    this.saveState()
    return [style === 'short' ? '⏰ Study time' : `⏰ ${say(style, 'hello', { name })}, time to study:`, '', ...lines].join('\n')
  }
  /** Short lines for the morning brief: today's exams and what's on the study plan. */
  plannerLines(u, today) {
    const out = this.examsOn(u, today).map((e) => `${this.examLine(e)} today`)
    const blocks = this.studyBlocks(u, today).filter((b) => !this.blockDone(b))
    if (blocks.length) {
      const p = this.plan(u)
      out.push(`📚 Study: ${blocks.map((b) => { const s = p.subjects.find((x) => x.id === b.subject); return `${s?.name || 'Study'}${b.mode ? ` (${b.mode})` : ''}` }).join(', ')} · *${this.slash(u)}study* for topics`)
    }
    return out
  }
  /** Tick (or untick) topic number n from Buddy's last study list. */
  tickTopic(u, n, codes = null) {
    const code = (codes || this.st(u).studyCodes)?.[n - 1]
    if (!code) return `There’s no (${n}) on my last study list. Send *${this.slash(u)}study* for a new one.`
    if (!this.planner?.study) return 'The study planner isn’t available.'
    const [date, bid, tid] = code
    let label = null, done = false
    this.planner.study.update(u, (p) => {
      const b = p.blocks.find((x) => x.id === bid && x.date === date)
      if (!b) return p
      if (tid) { const t = b.topics.find((x) => x.id === tid); if (t) { t.done = !t.done; done = t.done; label = t.text } }
      else { b.done = !b.done; done = b.done; label = p.subjects.find((x) => x.id === b.subject)?.name || 'Study' }
      return p
    })
    if (!label) return 'That one isn’t in your planner any more.'
    return done ? `✅ ${label}` : `↩️ Unticked: ${label}`
  }

  // ------------------------------------------------- reading a message
  changed(u, t) { try { this.onTaskChange(t) } catch {} return t }

  /** What a reply is about: the message it quotes (as Buddy recorded it, else the codes or names in its text). */
  fromQuote(u, quote) {
    if (!quote?.id) return {}
    const s = this.st(u)
    const rec = s.byMsg[quote.id]
    const tasks = this.store.snapshot(u).tasks
    const exists = (id) => tasks.some((t) => t.id === id)
    if (rec?.task && exists(rec.task)) return { task: rec.task }
    if (rec?.list?.length) return { list: rec.list }
    // older records: { codes: {1: id}, last }
    if (rec?.last && exists(rec.last) && !rec.codes) return { task: rec.last }
    if (rec?.codes && Object.keys(rec.codes).length) return { list: Object.keys(rec.codes).sort((a, b) => a - b).map((k) => rec.codes[k]) }
    const text = String(quote.text || '')
    // codes in the text ("📝 *Read Books* · K7", "2. ○ Makan Pome · 6:00 PM · B3")
    const codes = [...text.matchAll(/(?:^|[\s·(])([A-HJ-KM-NP-Z][2-9]\d?)(?=$|[\s·):,])/gm)].map((m) => s.tc[m[1]]).filter((id) => id && exists(id))
    const uniq = [...new Set(codes)]
    if (uniq.length === 1 && !/^\s*\d{1,2}\.\s/m.test(text)) return { task: uniq[0] }
    if (uniq.length) return { list: uniq }
    // before codes: a numbered list of titles, or one title in bold
    const byTitle = (title) => {
      const k = String(title || '').trim().toLowerCase()
      const same = tasks.filter((t) => t.title.trim().toLowerCase() === k)
      return same.find((t) => !t.done) || same.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0] || null
    }
    const list = []
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d{1,2})\.\s*(?:[○◐●✓☐☑]|⚠️?)?\s*(.+?)(?:\s+·\s+.*|\s+_\(.*\)_)?\s*$/u)
      const t = m && byTitle(m[2].replace(/[*_~]/g, ''))
      if (t) list[Number(m[1]) - 1] = t.id
    }
    if (list.filter(Boolean).length) return { list }
    const ids = [...new Set([...text.matchAll(/\*([^*\n]{1,200})\*/g)].map((m) => byTitle(m[1])?.id).filter(Boolean))]
    if (ids.length === 1) return { task: ids[0] }
    return {}
  }

  /**
   * Which task a command means: a code (K7) or a number from Buddy's last list at the start of
   * the arguments, else the task you replied to (or tapped), else the one Buddy just wrote about.
   * Returns { task, rest }, { pick: true } (ask with a menu) or { error }.
   */
  resolveTask(u, args, ctx, { numbers = true } = {}) {
    const s = this.st(u)
    const words = String(args || '').trim().split(/\s+/).filter(Boolean)
    const first = words[0] || ''
    if (CODE_RE.test(first) && !/^\d/.test(first)) {
      const t = this.taskOfCode(u, first)
      if (!t) return { error: `There’s no task *${first.toUpperCase()}*. Send *${this.slash(u)}today* or *${this.slash(u)}week* to see your codes.` }
      return { task: t, rest: words.slice(1).join(' ') }
    }
    // "#2", or "2" from the last list (not "2pm", "2 pm" or "2h")
    const num = first.match(/^#?(\d{1,2})$/)
    if (num && numbers && !/^(am|pm|m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i.test(words[1] || '')) {
      const list = ctx.list || s.list
      const id = list?.[Number(num[1]) - 1]
      const t = this.taskById(u, id)
      if (!t) return { error: `There’s no #${num[1]} on my last list. Send *${this.slash(u)}today* for a new one.` }
      return { task: t, rest: words.slice(1).join(' ') }
    }
    const id = ctx.task || (s.last && (ctx.now || Date.now()) - (s.lastAt || 0) < LAST_TTL ? s.last : null)
    const t = this.taskById(u, id)
    if (t) return { task: t, rest: words.join(' ') }
    return { pick: true, rest: words.join(' ') }
  }

  /** "Which task?": a menu of your open tasks; the tap runs the command on it. */
  pickItems(u, cmd, rest, now) {
    const { today } = this.ctx(u, now)
    const open = this.store.snapshot(u).tasks.filter((t) => !t.done)
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99'))
    if (!open.length) return [{ text: 'You have no open tasks.' }]
    const near = [...open.filter((t) => t.due && t.due <= today), ...open.filter((t) => !t.due || t.due > today)].slice(0, 12)
    return [this.menu(`Which task do you want to ${cmd.name}?`, near.map((t) => [`${this.codeOf(u, t)} · ${cut(t.title, 40)}`, t.id]), { kind: 'pick', cmd: cmd.name, rest })]
  }

  /**
   * A "when" in a message: { due, time, dayGiven, timeGiven }, or null if there isn't one.
   * strict: the message must be only the when ("6pm", "to fri 3pm", "besok jam 7pm").
   */
  whenOf(u, text, now = Date.now(), { strict = false } = {}) {
    const { today } = this.ctx(u, now)
    const s = ` ${String(text || '').replace(/\bbesok\b/gi, 'tomorrow').replace(/\blusa\b/gi, '').replace(/\b(?:jam|pukul)\s+(?=\d)/gi, '').replace(/\bmalam ini\b/gi, 'tonight').replace(/\bhari ini\b/gi, 'today')} `
    const p = parseQuickAdd(s, [], today)
    if (!p.due && !p.time) return null
    if (strict && p.title && !/^(?:to|ke|on|at|for|it|this|that|one|again|instead)?$/i.test(p.title.trim())) return null
    const noTime = s.replace(/\s(?:at\s)?\d{1,2}(?::\d{2})?\s?(?:am|pm)(?=\s)|\s(?:at\s)?(?:[01]?\d|2[0-3]):[0-5]\d(?=\s)|\s(?:at\s)?midnight(?=\s)/gi, ' ')
    const dayGiven = !!parseQuickAdd(noTime, [], today).due
    return { due: p.due || null, time: p.time || null, dayGiven, timeGiven: !!p.time }
  }
  /** Move one task to a new day and/or time. Its WhatsApp message and bell go off at the new time. */
  moveTo(u, task, when, now = Date.now()) {
    const { due, time } = this.moveTarget(u, task, when, now)
    return this.setWhen(u, task, due, time, now)
  }
  /** Where a move would put the task (without moving it). */
  moveTarget(u, task, when, now = Date.now()) {
    const { tz, today } = this.ctx(u, now)
    const time = when.timeGiven ? when.time : task.time || null
    let due
    if (when.dayGiven) due = when.due
    else {
      // just a time: the same day it's on (today if it's overdue or has no date); a time already gone today means tomorrow
      due = task.due && task.due > today ? task.due : today
      if (time && due === today && zonedTime(due, time, tz) <= now) due = addDaysKey(today, 1)
    }
    return { due, time }
  }
  setWhen(u, task, due, time, now = Date.now()) {
    const { today } = this.ctx(u, now)
    const where = due ? lower1(dueText({ due, time }, today)) : 'no date'
    if ((due || null) === (task.due || null) && (time || null) === (task.time || null)) return `*${task.title}* is already on ${where}.`
    const patch = { due: due || null, time: due ? time || null : null }
    // a fixed WhatsApp time (a snooze, or "at 6:43 PM") belonged to the old slot: back to its setting, at the new time
    if (typeof task.wa?.at === 'number') patch.wa = task.wa.base ? { ...task.wa.base } : { before: 0 }
    this.changed(u, this.store.updateTask(u, task.id, patch))
    return `📅 Moved *${task.title}* to ${where}.`
  }
  snoozeTo(u, task, at, now = Date.now()) {
    const { tz, style } = this.ctx(u, now)
    const base = typeof task.wa?.before === 'number' ? { before: task.wa.before } : task.wa?.base
    this.changed(u, this.store.updateTask(u, task.id, { wa: base ? { at, base } : { at } }))
    return say(style, 'snooze', { when: whenText(at, tz, now) }) + `\n_${task.title}_`
  }
  doneText(u, task, now = Date.now()) {
    const { tz, style, today } = this.ctx(u, now)
    if (task.done) return `✅ *${task.title}* is already done.`
    const saved = this.changed(u, this.store.updateTask(u, task.id, { status: 'done' }))
    const doc = this.store.snapshot(u)
    const doneToday = doc.tasks.filter((t) => t.done && t.doneAt && todayIn(tz, t.doneAt) === today).length
    const copy = saved.spawnedId && doc.tasks.find((t) => t.id === saved.spawnedId)
    if (copy) { const s = this.st(u); s.last = copy.id; s.lastAt = now; this.saveState() }
    return [say(style, 'done', { title: task.title }), copy ? `🔁 Next one: ${dueText(copy, today)} · ${this.codeOf(u, copy)}` : null, style === 'short' ? null : `That’s ${doneToday} today.`].filter(Boolean).join('\n')
  }
  stepText(u, task) {
    const subtasks = task.subtasks || []
    const i = subtasks.findIndex((s) => !s.done)
    if (i < 0) return `☑ No steps left on *${task.title}*.`
    const next = subtasks.map((s, k) => (k === i ? { ...s, done: true } : s))
    this.changed(u, this.store.updateTask(u, task.id, { subtasks: next }))
    const left = next.filter((s) => !s.done)
    return left.length ? `☑ Ticked: _${subtasks[i].title}_\nNext: _${left[0].title}_ (${next.length - left.length}/${next.length})` : `☑ Last step done on *${task.title}*.`
  }
  deleteNow(u, task, now = Date.now()) {
    const removed = this.store.deleteTask(u, task.id)
    this.changed(u, removed)
    const s = this.st(u)
    if (s.last === task.id) s.last = null
    s.removed = { task: removed, at: now }
    this.saveState()
    return `🗑 Deleted *${task.title}*.\n_Wrong one? Send *${this.slash(u)}undo* to bring it back._`
  }
  /** A new task from "/add …" (or a tap on "Add …"). With a day or time, Buddy also WhatsApps you then. */
  addItems(u, text, now = Date.now()) {
    const { doc, tz, today } = this.ctx(u, now)
    const raw = String(text || '').replace(/^\s*me\s+(?:to\s+)?/i, '') // "/remind me to call mum 8pm"
    const parsed = parseQuickAdd(` ${raw.replace(/\bbesok\b/gi, 'tomorrow')} `, doc.lists, today)
    if (!parsed.title) return [{ text: `⚠️ Add what?\nUsage: \`${this.slash(u)}add <task> [day] [time]\`\nExample: \`${this.slash(u)}add buy milk tomorrow 5pm\`` }]
    const { hints: _h, ...fields } = parsed
    // "at 8pm" when it's already past 8pm today (and you didn't say today) means tomorrow
    if (fields.time && fields.due === today && zonedTime(today, fields.time, tz) <= now && !/\b(today|tonight|hari ini)\b/i.test(raw)) fields.due = addDaysKey(today, 1)
    if (fields.time) fields.remind = 0
    if (fields.due) fields.wa = { before: 0 }
    const task = this.store.addTask(u, fields)
    const s = this.st(u); s.last = task.id; s.lastAt = now; this.saveState()
    const code = this.codeOf(u, task)
    const lines = [`✅ Added: *${task.title}* · ${code}`]
    if (task.due) lines.push(`📅 ${dueText(task, today)}`, `💬 I’ll WhatsApp you ${task.time ? `at ${time12(task.time)}` : 'that day at 9:00 AM'}`)
    else lines.push('_No date, so no reminder._')
    return [
      { text: lines.join('\n'), about: { task: task.id } },
      this.menu('Anything to change?', [['📅 Change day/time…', 'moveMenu'], ['💬 Change my reminder…', 'waMenu'], ['✏️ Rename…', 'rename'], ['🗑 Undo (remove it)', 'remove']], { kind: 'task', task: task.id }, 'menu', { task: task.id }),
    ]
  }
  snoozeMenu(u, task, now = Date.now()) {
    const { tz, today } = this.ctx(u, now)
    const opts = [['In 15 minutes', `ms:${now + 15 * 60e3}`], ['In 1 hour', `ms:${now + 3600e3}`], ['In 3 hours', `ms:${now + 3 * 3600e3}`]]
    if (now < zonedTime(today, '19:30', tz)) opts.push(['Tonight 8 PM', `ms:${zonedTime(today, '20:00', tz)}`])
    opts.push(['Tomorrow 9 AM', `ms:${zonedTime(addDaysKey(today, 1), '09:00', tz)}`], ['⌨️ Type a time…', 'type'])
    return this.menu(`Snooze ${cut(task.title, 50)} until…`, opts, { kind: 'snooze', task: task.id })
  }
  moveMenu(u, task, now = Date.now()) {
    const { tz, today } = this.ctx(u, now)
    const tm = task.time || null
    const tmr = addDaysKey(today, 1)
    const opts = []
    if (now < zonedTime(today, '17:00', tz)) opts.push(['Today 6 PM', `when:${today}|18:00`])
    if (now < zonedTime(today, '20:30', tz)) opts.push(['Tonight 9 PM', `when:${today}|21:00`])
    opts.push([tm ? `Tomorrow ${time12(tm)}` : 'Tomorrow', `when:${tmr}|${tm || ''}`])
    if (tm !== '09:00') opts.push(['Tomorrow 9 AM', `when:${tmr}|09:00`])
    for (let i = 2; i <= 4; i++) { const d = addDaysKey(today, i); opts.push([`${dayLabel(d, today)}${tm ? ` ${time12(tm)}` : ''}`, `when:${d}|${tm || ''}`]) }
    const sat = addDaysKey(today, ((6 - weekdayOf(today) + 7) % 7) || 7)
    if (sat > addDaysKey(today, 4)) opts.push([`Weekend (${dayLabel(sat, today)})`, `when:${sat}|${tm || ''}`])
    opts.push([`Next week (${dayLabel(addDaysKey(today, 7), today)})`, `when:${addDaysKey(today, 7)}|${tm || ''}`])
    if (task.due) opts.push(['No date', 'when:|'])
    opts.push(['⌨️ Type a day or time…', 'type'])
    return this.menu(`Move ${cut(task.title, 50)} to…`, opts, { kind: 'move', task: task.id })
  }
  waMenu(u, task) {
    const opts = task.time
      ? [['At the time', 'wa:0'], ['15 minutes before', 'wa:15'], ['1 hour before', 'wa:60'], ['1 day before', 'wa:1440']]
      : [['On the day, 9 AM', 'wa:0'], ['1 day before, 9 AM', 'wa:1440']]
    if (!task.due) return { text: `*${task.title}* has no date, so I can’t remind you about it. Give it one first: *${this.slash(u)}move ${this.codeOf(u, task)} tomorrow 9am*` }
    opts.push(['🔕 No WhatsApp reminder', 'wa:off'])
    return this.menu(`WhatsApp you about ${cut(task.title, 50)}…`, opts, { kind: 'wa', task: task.id })
  }
  setWa(u, task, v) {
    if (v === 'off') { this.changed(u, this.store.updateTask(u, task.id, { wa: null })); return `🔕 No WhatsApp reminder for *${task.title}*.` }
    const before = Number(v)
    this.changed(u, this.store.updateTask(u, task.id, { wa: { before } }))
    const label = before === 0 ? (task.time ? `at ${time12(task.time)}` : 'that day at 9:00 AM') : before === 1440 ? 'the day before' : `${before === 60 ? '1 hour' : `${before} minutes`} before`
    return `💬 I’ll WhatsApp you ${label}: *${task.title}*`
  }

  // --------------------------------------------------- running commands
  /**
   * Everything that comes in from WhatsApp goes through here. Returns the messages to send back
   * (texts and tap menus). `chat`: 'bot' or 'self'. `quote`: the message it replies to.
   */
  async run(u, text, { chat = 'bot', quote = null, now = Date.now(), id = null } = {}) {
    const s = this.st(u)
    const ctx = { chat, now, ...this.fromQuote(u, quote) }
    const p = parseCommand(text, chat)
    const flow = s.flow && now - s.flow.at < (FLOW_TTL[chat] || FLOW_TTL.bot) ? s.flow : null
    // Waiting for a typed answer ("6pm"): plain words answer it; only a "/command" interrupts.
    if (flow && !(p?.cmd && p.prefixed) && !p?.unknown) {
      if (/^(cancel|stop|batal|never ?mind|no)$/i.test(String(text).trim())) { s.flow = null; this.saveState(); return [{ text: 'Okay, cancelled.' }] }
      return this.runFlow(u, flow, String(text).trim(), ctx)
    }
    // Without a "/", a message is a command only if all of it fits ("done", "done K7", "move 6pm"):
    // "finished the bio homework" or "push maths to friday" are sentences, not /done or /move.
    if (p?.cmd && (p.prefixed || this.bareOk(u, p.cmd, p.args, now))) {
      if (s.flow) {
        s.flow = null
        this.saveState()
        if (p.cmd.name === 'cancel') return [{ text: 'Okay, cancelled.' }]
      }
      return this.runCommand(u, p.cmd, p.args, ctx)
    }
    if (p?.unknown) {
      const near = closest(p.unknown.toLowerCase())
      const t = String(text).trim().replace(/^(\/|td\s*)/i, '')
      return [
        { text: `⚠️ I don’t know *${this.slash(u)}${cut(p.unknown, 30)}*.${near ? ` Did you mean *${this.slash(u)}${near}*?` : ''}\nSend *${this.slash(u)}help* for all commands.` },
        this.mainMenu([[`➕ Add “${cut(t, 40)}” as a task`, `addText:${t.slice(0, 300)}`]]),
      ]
    }
    if (chat !== 'bot') return [] // a note in your own chat: not for Buddy
    const body = String(text || '').trim()
    if (!body) return []
    // "yes" / "no" (or an option's words) typed right after a question: the same as tapping it
    const typed = this.typedAnswer(u, body, now)
    if (typed) return this.tap(u, typed.id, [typed.option], { now })
    // thanks / ok: answered like a person would (a reply, or a 👍 on your message)
    const talk = smallTalk(body)
    if (talk === 'thanks') return [{ text: THANKS_BACK[Math.floor(Math.random() * THANKS_BACK.length)].replace('{name}', this.ctx(u, now).name) }]
    if (talk === 'ack') return id ? [{ react: '👍', to: id }] : []
    // anything else: the AI (if the admin set one up) answers, and proposes what to change
    const ai = this.ai
    if (ai) {
      const items = await this.aiItems(u, body, ctx, ai)
      if (items) return items
    }
    const sorry = ai ? '🤖 Sorry, my brain didn’t get that one just now.' : null
    // a reply to my message about a task: what you can do with it (always answered: you're clearly talking to me)
    const about = this.taskById(u, ctx.task)
    if (about) return [{ text: `${sorry || '🤖 I don’t guess what that means.'} Tap what to do with *${about.title}*, or send *help*.`, about: { task: about.id } }, this.taskMenu(u, about)]
    // otherwise: say what works, and offer to add it as a task (not every time: once in a while)
    const quiet = now - (s.unknownAt || 0) < 2 * 60e3
    s.unknownAt = now
    this.saveState()
    if (quiet) return [{ text: sorry ? `${sorry} Try again in a bit, or send *help*.` : 'That’s not a command. Tap a menu, or send *help*.' }]
    return [
      { text: `${sorry || '🤖 I only understand commands and taps, so I don’t guess.'}\nTap below, or send *help* for all commands.` },
      this.mainMenu([[`➕ Add “${cut(body, 40)}” as a task`, `addText:${body.slice(0, 300)}`]]),
    ]
  }

  /** A typed answer to Buddy's latest question ("yes", "no", or an option's words): { id, option } or null. */
  typedAnswer(u, text, now = Date.now()) {
    const s = this.st(u)
    let id = null, m = null
    for (const [k, v] of Object.entries(s.menus)) if (!m || v.at > m.at) { id = k; m = v }
    if (!m || m.answered || now - m.at > TYPED_TTL) return null
    const t = normLabel(text)
    let i = t ? m.options.findIndex((o) => normLabel(o) === t) : -1
    if (i < 0 && Array.isArray(m.values)) {
      if (YES.test(text.trim())) i = m.values.indexOf('yes')
      else if (NO.test(text.trim())) i = m.values.indexOf('no')
    }
    return i >= 0 ? { id, option: m.options[i] } : null
  }

  /** The chat so far (for the AI): what you said and what Buddy said, the last half hour. */
  remember(u, who, text, now = Date.now()) {
    if (!text) return
    const s = this.st(u)
    s.talk = [...(s.talk || []).filter((x) => now - x.at < TALK_TTL), { who, text: cut(String(text).replace(/\s+/g, ' '), 300), at: now }].slice(-10)
    this.saveState()
  }

  /** A command the AI proposed, in plain words: “Move “Maths” to fri 30 oct, 3:00 PM”. */
  describe(u, p, t, now = Date.now()) {
    const { tz, today } = this.ctx(u, now)
    const rest = p.args.split(/\s+/).slice(1).join(' ')
    const q = t ? `“${cut(t.title, 50)}”` : 'it'
    switch (p.cmd.name) {
      case 'add': return `Add “${cut(p.args, 80)}”`
      case 'done': return `Tick off ${q}`
      case 'start': return `Start ${q}`
      case 'step': return `Tick the next step of ${q}`
      case 'snooze': return `Remind you about ${q} again ${whenText(snoozeUntil(rest || 'later', tz, now) || now + 3600e3, tz, now)}`
      case 'move': { const w = this.whenOf(u, rest, now, { strict: true }); const to = w && this.moveTarget(u, t, w, now); return to?.due ? `Move ${q} to ${lower1(dueText(to, today))}` : `Move ${q} to ${rest}` }
      case 'rename': return `Rename ${q} to “${cut(rest, 60)}”`
      case 'delete': return `Delete ${q}`
      case 'undo': return 'Bring back the task you deleted last'
    }
    return `/${p.cmd.name} ${p.args}`.trim()
  }

  /** A command word without the "/" (bot chat): does the rest of the message fit it exactly? */
  bareOk(u, cmd, args, now) {
    const a = String(args || '').trim()
    if (!a) return true
    if (cmd.name === 'add' || cmd.name === 'help' || cmd.name === 'clear' || cmd.name === 'topic' || cmd.name === 'rename') return cmd.name !== 'rename' || CODE_RE.test(a.split(/\s+/)[0])
    if (cmd.name === 'study') return /^(tomorrow|tmr|besok)$/i.test(a)
    if (!cmd.task) return false
    const first = a.split(/\s+/)[0]
    if ((CODE_RE.test(first) && this.taskOfCode(u, first)) || /^#\d{1,2}$/.test(first) || (/^\d{1,2}$/.test(first) && a.split(/\s+/).length === 1)) return true
    if (cmd.name === 'move') return !!this.whenOf(u, a, now, { strict: true })
    if (cmd.name === 'snooze') return !!snoozeUntil(a, this.ctx(u, now).tz, now)
    return false
  }

  async runCommand(u, cmd, args, ctx) {
    const { now } = ctx
    const { today } = this.ctx(u, now)
    const s = this.st(u)
    const sl = this.slash(u)
    const usage = (extra = '') => [{ text: `⚠️ ${extra ? `${extra}\n` : ''}Usage: \`${sl}${cmd.usage.replace(/^\//, '')}\`${cmd.example ? `\nExample: \`${sl}${cmd.example.replace(/^\//, '')}\`` : ''}` }]
    switch (cmd.name) {
      case 'help': return [{ text: this.helpMessage(u, args) }]
      case 'menu': return [{ text: `👋 Hi ${this.ctx(u, now).name}, I’m Buddy. Tap below, or send *${sl}help* for all commands.` }, this.mainMenu()]
      case 'test': return [this.menu('🧪 Buddy test menu: tap any option', [['✅ Option A', 'A'], ['⏰ Option B', 'B'], ['📅 Option C', 'C']], { kind: 'test' })]
      case 'cancel': {
        // nothing waiting: "cancel" on a task (the one you replied to, or just added) means delete it, after a tap to confirm
        const r = this.resolveTask(u, args, ctx, { numbers: true })
        if (r.task && !r.task.done) return [this.menu(`Delete ${cut(r.task.title, 60)}?`, [['🗑 Yes, delete it', 'yes'], ['↩️ No, keep it', 'no']], { kind: 'delete', task: r.task.id }, 'menu', { task: r.task.id })]
        return [{ text: 'Nothing to cancel.' }]
      }
      case 'today': return this.listItems(u, 'Today', this.todayList(u, now), { now, empty: '📋 *Today*: nothing open. Enjoy!' })
      case 'tomorrow': return this.listItems(u, 'Tomorrow', this.dateList(u, addDaysKey(today, 1), addDaysKey(today, 2), now), { now })
      case 'week': return this.listItems(u, 'Next 7 days', this.dateList(u, today, addDaysKey(today, 8), now), { now, days: true })
      case 'overdue': return this.listItems(u, 'Overdue', this.store.snapshot(u).tasks.filter((t) => !t.done && t.due && t.due < today)
        .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99')), { now })
      case 'add': {
        if (!args) { s.flow = { kind: 'add', at: now }; this.saveState(); return [{ text: `What’s the task? Send it like: *buy milk tomorrow 5pm*\n_Or ${sl}cancel._` }] }
        return this.addItems(u, args, now)
      }
      case 'undo': {
        const r = s.removed
        if (!r || now - r.at > 24 * 3600e3) return [{ text: 'Nothing to undo.' }]
        const { id: _i, order: _o, createdAt: _c, updatedAt: _up, doneAt: _d, spawnedId: _s, ...input } = r.task
        if (input.wa) { const { sent: _x, ...wa } = input.wa; input.wa = typeof wa.at === 'number' && wa.at < now ? (wa.base || { before: 0 }) : wa }
        let back
        try { back = this.store.addTask(u, input) } catch (e) { return [{ text: `Couldn’t bring *${r.task.title}* back: ${e.message}` }] }
        this.changed(u, back)
        s.removed = null
        this.saveState()
        return [{ text: `↩️ *${back.title}* is back · ${this.codeOf(u, back)}${back.due ? `\n${dueText(back, today)}` : ''}`, about: { task: back.id } }]
      }
      case 'study': return this.studyItems(u, /\b(tomorrow|tmr|besok)\b/i.test(args) ? addDaysKey(today, 1) : today, now)
      case 'topic': {
        const n = args.match(/^#?\(?(\d{1,2})\)?$/)
        return n ? [{ text: this.tickTopic(u, Number(n[1])) }] : usage()
      }
      case 'exams': return [{ text: this.upcomingExams(u, now) }]
      case 'clear': {
        const what = args.toLowerCase()
        if (/^(completed|done|finished)$/.test(what)) { const r = this.store.clearCompleted(u); return [{ text: r.removed ? `🧹 Cleared ${r.removed} finished task${r.removed === 1 ? '' : 's'}.` : 'Nothing finished to clear.' }] }
        if (/^reminders?$/.test(what)) { const n = this.store.clearWaReminders(u); this.clearSent(u, ['reminder', 'nudge']).catch(() => {}); return [{ text: n ? `🧹 Cleared ${n} WhatsApp reminder${n === 1 ? '' : 's'} and deleting my recent reminder messages.` : '🧹 No reminders set. Deleting my recent reminder messages anyway.' }] }
        if (/^(messages|buddy|chat)$/.test(what)) { this.clearSent(u).catch(() => {}); return [{ text: '🧹 Deleting my recent messages.' }] }
        return usage()
      }
    }
    // ---- commands on one task
    const r = this.resolveTask(u, args, ctx)
    if (r.error) return [{ text: `⚠️ ${r.error}` }]
    if (r.pick) {
      if (cmd.name === 'task') return usage()
      return this.pickItems(u, cmd, r.rest, now)
    }
    const t = r.task
    const rest = r.rest
    switch (cmd.name) {
      case 'task': return this.taskItems(u, t, { head: '', now })
      case 'done': return [{ text: this.doneText(u, t, now), about: { task: t.id } }]
      case 'start':
        if (t.done) return [{ text: `✅ *${t.title}* is already done.` }]
        this.changed(u, this.store.updateTask(u, t.id, { status: 'doing' }))
        return [{ text: say(this.ctx(u, now).style, 'start', { title: t.title }), about: { task: t.id } }]
      case 'step': return [{ text: this.stepText(u, t), about: { task: t.id } }]
      case 'snooze': {
        const at = snoozeUntil(rest, this.ctx(u, now).tz, now)
        if (!at) return usage(`I can’t read “${cut(rest, 30)}” as a time. Try 30m, 2h, 6pm, tonight or tomorrow.`)
        return [{ text: this.snoozeTo(u, t, at, now), about: { task: t.id } }]
      }
      case 'move': {
        if (!rest) return [this.moveMenu(u, t, now)]
        const when = this.whenOf(u, rest, now, { strict: true })
        if (!when) return usage(`I can’t read “${cut(rest, 30)}” as a day or time.`)
        return [{ text: this.moveTo(u, t, when, now), about: { task: t.id } }]
      }
      case 'rename': {
        if (!rest) { s.flow = { kind: 'rename', task: t.id, at: now }; this.saveState(); return [{ text: `What should *${t.title}* be called?\n_Or ${sl}cancel._`, about: { task: t.id } }] }
        this.changed(u, this.store.updateTask(u, t.id, { title: rest.slice(0, 200) }))
        return [{ text: `✏️ Renamed to *${rest.slice(0, 200)}*.`, about: { task: t.id } }]
      }
      case 'delete': return [this.menu(`Delete ${cut(t.title, 60)}?`, [['🗑 Yes, delete it', 'yes'], ['↩️ No, keep it', 'no']], { kind: 'delete', task: t.id }, 'menu', { task: t.id })]
    }
    return usage()
  }

  /** A typed answer to what Buddy asked ("Type a time…", "What's the task?", "What should it be called?"). */
  runFlow(u, flow, text, ctx) {
    const s = this.st(u)
    const { now } = ctx
    const done = (items) => { s.flow = null; this.saveState(); return items }
    if (flow.kind === 'add') return done(this.addItems(u, text, now))
    const t = this.taskById(u, flow.task)
    if (!t) return done([{ text: 'That task is gone.' }])
    if (flow.kind === 'rename') {
      if (!text) return [{ text: 'Send the new name, or /cancel.' }]
      this.changed(u, this.store.updateTask(u, t.id, { title: text.slice(0, 200) }))
      return done([{ text: `✏️ Renamed to *${text.slice(0, 200)}*.`, about: { task: t.id } }])
    }
    if (flow.kind === 'snooze') {
      const at = snoozeUntil(text, this.ctx(u, now).tz, now)
      if (!at) return [{ text: `⚠️ I can’t read “${cut(text, 30)}” as a time. Try *30m*, *2h*, *6pm*, *tonight* or *tomorrow*, or ${this.slash(u)}cancel.` }]
      return done([{ text: this.snoozeTo(u, t, at, now), about: { task: t.id } }])
    }
    if (flow.kind === 'move') {
      const when = this.whenOf(u, text, now, { strict: true })
      if (!when) return [{ text: `⚠️ I can’t read “${cut(text, 30)}” as a day or time. Try *6pm*, *tomorrow*, *fri 3pm* or *25 oct*, or ${this.slash(u)}cancel.` }]
      return done([{ text: this.moveTo(u, t, when, now), about: { task: t.id } }])
    }
    return done([])
  }

  /** A tap on one of Buddy's menus. Returns the messages to send back. */
  async tap(u, pollId, picks, { now = Date.now() } = {}) {
    const s = this.st(u)
    const menu = s.menus[pollId]
    const choice = picks?.[0]
    if (!menu || now - menu.at > MENU_TTL || !choice) return []
    const i = menu.options.indexOf(choice)
    if (i < 0) return []
    if (!menu.answered) { menu.answered = now; this.saveState() }
    // the same tap reported twice (WhatsApp sends votes two ways) counts once
    const key = `${u}|${pollId}|${choice}`
    if (now - (this.recentTaps.get(key) || 0) < 15e3) return []
    this.recentTaps.set(key, now)
    if (this.recentTaps.size > 500) this.recentTaps.clear()
    const v = String(menu.values?.[i] ?? choice)
    const m = menu.meta || {}
    const ctx = { chat: 'bot', now }
    const cmd = (name, args = '') => this.runCommand(u, BY_NAME.get(name), args, ctx)
    if (m.kind === 'test') return [{ text: `✅ Got your tap: *${choice}*\n_Taps work in this chat. Tap another option to try again._` }]
    if (m.kind === 'main' || m.kind === 'list') {
      if (v.startsWith('cmd:')) return cmd(v.slice(4))
      if (v === 'add') { s.flow = { kind: 'add', at: now }; this.saveState(); return [{ text: 'What’s the task? Send it like: *buy milk tomorrow 5pm*' }] }
      if (v.startsWith('addText:')) return this.addItems(u, v.slice(8), now)
      if (v === 'moveAll') {
        const list = this.todayList(u, now)
        if (!list.length) return [{ text: 'Nothing left to move.' }]
        const tmr = addDaysKey(this.ctx(u, now).today, 1)
        for (const t of list) this.setWhen(u, t, tmr, t.time || null, now)
        return [{ text: `📅 Moved ${list.length} task${list.length === 1 ? '' : 's'} to tomorrow.` }]
      }
      if (v.startsWith('open:')) { const t = this.taskById(u, v.slice(5)); return t ? this.taskItems(u, t, { head: '', now }) : [{ text: 'That task is gone.' }] }
      return []
    }
    if (m.kind === 'ai') {
      if (v === 'no') { this.remember(u, 'buddy', '(they said no; nothing changed)', now); return [{ text: 'Okay, nothing changed.' }] }
      const out = []
      for (const c of m.commands || (m.command ? [m.command] : [])) {
        const p = parseCommand(c, 'bot')
        if (p?.cmd) out.push(...(await this.runCommand(u, p.cmd, p.args, ctx)))
      }
      this.remember(u, 'buddy', out.filter((x) => x.text).map((x) => x.text).join(' / '), now)
      return out
    }
    if (m.kind === 'pick') {
      const t = this.taskById(u, v)
      return t ? this.runCommand(u, BY_NAME.get(m.cmd), `${this.codeOf(u, t)} ${m.rest || ''}`.trim(), ctx) : [{ text: 'That task is gone.' }]
    }
    if (m.kind === 'study') { const n = Number(v.replace('topic:', '')); return [{ text: this.tickTopic(u, n, m.codes) }] }
    // ---- menus about one task
    const t = this.taskById(u, m.task)
    if (!t) return [{ text: 'That task is gone.' }]
    const about = { task: t.id }
    if (m.kind === 'task') {
      switch (v) {
        case 'done': return [{ text: this.doneText(u, t, now), about }]
        case 'undone': this.changed(u, this.store.updateTask(u, t.id, { status: 'todo' })); return [{ text: `↩️ *${t.title}* is open again.`, about }]
        case 'start': return cmd('start', this.codeOf(u, t))
        case 'step': return [{ text: this.stepText(u, t), about }]
        case 'snooze1h': return t.done ? [{ text: `✅ *${t.title}* is already done.` }] : [{ text: this.snoozeTo(u, t, now + 3600e3, now), about }]
        case 'snoozeMenu': return [this.snoozeMenu(u, t, now)]
        case 'moveMenu': return [this.moveMenu(u, t, now)]
        case 'waMenu': return [this.waMenu(u, t)]
        case 'rename': s.flow = { kind: 'rename', task: t.id, at: now }; this.saveState(); return [{ text: `What should *${t.title}* be called? Send the new name.`, about }]
        case 'delete': return [this.menu(`Delete ${cut(t.title, 60)}?`, [['🗑 Yes, delete it', 'yes'], ['↩️ No, keep it', 'no']], { kind: 'delete', task: t.id }, 'menu', about)]
        case 'remove': return [{ text: this.deleteNow(u, t, now) }]
      }
      return []
    }
    if (m.kind === 'delete') return v === 'yes' ? [{ text: this.deleteNow(u, t, now) }] : [{ text: `👍 Kept *${t.title}*.`, about }]
    if (m.kind === 'snooze') {
      if (v === 'type') { s.flow = { kind: 'snooze', task: t.id, at: now }; this.saveState(); return [{ text: `Until when? Send a time like *30m*, *2h*, *6pm* or *tomorrow*.`, about }] }
      const at = Number(v.slice(3))
      return [{ text: this.snoozeTo(u, t, at > now ? at : now + 3600e3, now), about }]
    }
    if (m.kind === 'move') {
      if (v === 'type') { s.flow = { kind: 'move', task: t.id, at: now }; this.saveState(); return [{ text: `To when? Send a day and/or time like *6pm*, *tomorrow*, *fri 3pm* or *25 oct*.`, about }] }
      const [due, time] = v.slice(5).split('|')
      return [{ text: this.setWhen(u, t, due || null, time || null, now), about }]
    }
    if (m.kind === 'wa') return [{ text: this.setWa(u, t, v.slice(3)), about }]
    return []
  }

  /** A reaction on one of Buddy's messages: 👍 (or ✅, 👌) on a message about one task ticks it off. */
  react(u, msgId, emoji, { now = Date.now() } = {}) {
    const rec = this.st(u).byMsg[msgId]
    if (!rec?.task || !DONE_EMOJI.has(String(emoji || ''))) return []
    const t = this.taskById(u, rec.task)
    if (!t || t.done) return []
    return [{ text: this.doneText(u, t, now), about: { task: t.id } }]
  }

  /**
   * The AI's answer: what it says back, lists it shows straight away, and changes it proposes
   * (one menu: "Yes, do it" / "No"). Null: no usable answer (Buddy falls back to commands and taps).
   */
  async aiItems(u, body, ctx, ai) {
    const { now } = ctx
    const { tz, today, name, doc } = this.ctx(u, now)
    const s = this.st(u)
    const when = (t) => (t.due ? `${t.due} ${t.time || ''}` : '9999')
    const open = doc.tasks.filter((t) => !t.done).sort((a, b) => when(a).localeCompare(when(b))).slice(0, 40)
    // one short line per task (fewer tokens: Groq's free tier counts them)
    const tasks = open.map((t) => {
      const o = [this.codeOf(u, t), cut(t.title, 80)]
      if (t.due) o.push(dueText(t, today) || dayLabel(t.due, today))
      if (t.due && t.due < today) o.push('overdue')
      if (t.status === 'doing') o.push('started')
      const steps = t.subtasks || []
      if (steps.length) o.push(`steps ${steps.filter((x) => x.done).length}/${steps.length}`)
      if (t.priority >= 2) o.push('important')
      if (t.notes) o.push(`notes: ${cut(String(t.notes).replace(/\s+/g, ' '), 80)}`)
      return o.join(' · ')
    })
    const finished = doc.tasks.filter((t) => t.done && t.doneAt && now - t.doneAt < 3 * 864e5).sort((a, b) => b.doneAt - a.doneAt).slice(0, 10)
      .map((t) => `${cut(t.title, 80)} · ${dayLabel(todayIn(tz, t.doneAt), today)}, ${time12(hmIn(tz, t.doneAt))}`)
    const cur = this.taskById(u, ctx.task || (now - (s.lastAt || 0) < LAST_TTL ? s.last : null))
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(new Date(now))
    const recent = (s.talk || []).filter((x) => now - x.at < TALK_TTL).map((x) => `${x.who === 'me' ? name : 'Buddy'}: ${x.text}`)
    let out
    try {
      out = await this.propose({ key: ai.key, model: ai.model, text: body, name, now: `${weekday} ${today}, ${time12(hmIn(tz, now))}`, tasks, finished, current: cur && !cur.done ? this.codeOf(u, cur) : null, recent })
    } catch (e) { console.warn(`[buddy] AI didn't answer: ${e.message}`); return null }
    if (typeof out === 'string') out = { reply: null, commands: [out] }
    const reply = out?.reply ? String(out.reply).trim() : null
    // keep only commands that are real and safe: known command, real code, a day/time it can read
    const read = [], change = []
    for (const c of out?.commands || []) {
      const p = parseCommand(c, 'bot')
      if (!p?.cmd || !AI_ALLOWED.has(p.cmd.name)) continue
      const parts = p.args.split(/\s+/).filter(Boolean)
      const rest = parts.slice(1).join(' ')
      let t = null
      if (p.cmd.task) {
        t = CODE_RE.test(parts[0] || '') ? this.taskOfCode(u, parts[0]) : null
        if (!t) continue
        if (p.cmd.name === 'move' && !this.whenOf(u, rest, now, { strict: true })) continue
        if (p.cmd.name === 'snooze' && rest && !snoozeUntil(rest, tz, now)) continue
        if (p.cmd.name === 'rename' && !rest) continue
      }
      if (p.cmd.name === 'add' && !p.args) continue
      const x = { p, t, shown: `/${p.cmd.name}${p.args ? ` ${p.args}` : ''}` }
      if (AI_READ_ONLY.has(p.cmd.name)) { if (!read.some((y) => y.shown === x.shown)) read.push(x) } else if (!change.some((y) => y.shown === x.shown)) change.push(x)
    }
    if (!reply && !read.length && !change.length) return null
    this.remember(u, 'me', body, now)
    const items = []
    const one = [...read, ...change].length === 1 ? (read[0] || change[0]).t : null
    if (reply) items.push({ text: reply, ...(one ? { about: { task: one.id } } : {}) })
    for (const x of read.slice(0, 3)) items.push(...(await this.runCommand(u, x.p.cmd, x.p.args, ctx)))
    if (change.length) {
      const lines = change.map((x) => this.describe(u, x.p, x.t, now))
      const title = lines.length === 1 ? `${lines[0]}?` : `Do these?\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
      items.push(this.menu(cut(title, 250), [[lines.length === 1 ? '✅ Yes, do it' : `✅ Yes, all ${lines.length}`, 'yes'], ['❌ No', 'no']], { kind: 'ai', commands: change.map((x) => x.shown) }, 'menu', one ? { task: one.id } : null))
    }
    this.remember(u, 'buddy', [reply, ...change.map((x) => `(asked: ${this.describe(u, x.p, x.t, now)}?)`), ...read.map((x) => `(showed ${x.shown})`)].filter(Boolean).join(' '), now)
    return items
  }

  // ----------------------------------------------- exam + study reminders
  /** Exam and study reminders: the evening before an exam, the day's study plan, and each timed study block. */
  async plannerTick(u, b, s, tz, today, now) {
    const due = (hm, window = BRIEF_WINDOW) => { const at = zonedTime(today, hm, tz); return now >= at && now - at <= window }
    const go = async (items, kind) => {
      try { await this.deliver(u, items); console.log(`[buddy] ${u}: ${kind} → WhatsApp`) } catch (e) { console.warn(`[buddy] ${u}: ${kind} failed: ${e.message}`) }
    }
    // (marked as sent only once something goes out: an exam or a block added a bit later still gets its message)
    if (b.exams && b.examsAt && s.examEve !== today && due(b.examsAt)) {
      const list = this.examsOn(u, addDaysKey(today, 1))
      if (list.length) {
        s.examEve = today
        this.saveState()
        await go([{ text: this.examMessage(u, list, now), kind: 'exam' }], 'exam')
      }
    }
    if (b.study && s.studyDay !== today && due(b.study) && this.studyBlocks(u, today).some((x) => !this.blockDone(x))) {
      s.studyDay = today
      this.saveState()
      await go(this.studyItems(u, today, now), 'study')
    }
    if (b.studyBlocks) {
      for (const blk of this.studyBlocks(u, today)) {
        if (!blk.time || this.blockDone(blk)) continue
        const key = `${today}|${blk.id}|${blk.time}`
        if ((s.blocksSent || []).includes(key) || !due(blk.time, 2 * 3600e3)) continue
        s.blocksSent = [...(s.blocksSent || []), key].slice(-200)
        this.saveState()
        const text = this.blockMessage(u, blk, now)
        await go([{ text, kind: 'study' }, this.topicMenu(u, this.st(u).studyCodes || [], 'study')], 'study')
      }
    }
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
        // a repeat made by an older version kept the last one's fixed time (from an earlier date,
        // older than the task itself), so it showed "Sent" and never went off. Back to its own time.
        if (t.repeat && t.due && typeof t.wa.at === 'number' && t.createdAt > t.wa.at + 60e3 && t.wa.at < zonedTime(t.due, '00:00', tz)) {
          try { this.store.updateTask(u, t.id, { wa: t.wa.base ? { ...t.wa.base } : { before: 0 } }); console.log(`[buddy] ${u}: "${t.title}" repeat's WhatsApp back to its own time`) } catch {}
          continue // picked up on the next tick with the new time
        }
        const at = waInstant(t, tz)
        const sig = waSig(t)
        if (at === null || at > now || t.wa.sent === sig) continue
        this.store.setWaSent(u, t.id, sig) // first, so it never goes out twice
        if (now - at > LATE) continue
        // a time that had already passed when the task was made (added at 8 PM, "on the day" = 9 AM): nothing to remind
        if (at < (t.createdAt || 0) - 60e3) continue
        try {
          await this.deliver(u, this.taskItems(u, t, { kind: 'reminder', now }))
          console.log(`[buddy] ${u}: "${t.title}" → WhatsApp`)
        } catch (e) { console.warn(`[buddy] ${u}: ${e.message}`) }
      }
      const b = this.settings(u)
      const today = todayIn(tz, now)
      const s = this.st(u)
      if (this.planner) await this.plannerTick(u, b, s, tz, today, now)
      // the morning brief and the evening check-in
      if (!b.on) continue
      for (const kind of ['morning', 'evening']) {
        if (!b[kind] || s[kind] === today) continue
        const at = zonedTime(today, b[kind], tz)
        if (now < at || now - at > BRIEF_WINDOW) continue
        s[kind] = today
        this.saveState()
        try {
          await this.deliver(u, kind === 'morning' ? this.morningItems(u, now) : this.eveningItems(u, now))
          console.log(`[buddy] ${u}: ${kind} message → WhatsApp`)
        } catch (e) { console.warn(`[buddy] ${u}: ${kind} failed: ${e.message}`) }
      }
    }
  }
}
