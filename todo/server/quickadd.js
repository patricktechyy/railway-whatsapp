import { describeRepeat } from './repeat.js'

/* Shared by the browser (the New task box) and the server (tasks sent from
   WhatsApp). Plain JavaScript so both can use it; types in quickadd.d.ts. */

const pad = (n) => String(n).padStart(2, '0')
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }
const localToday = () => toKey(new Date())
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d) }
const weekday = (k) => fromKey(k).getDay()

/** A safe, normalised http(s) URL, or null. Trailing punctuation from a sentence is dropped. */
export function cleanUrl(raw) {
  const s = String(raw || '').trim().replace(/[.,;:!?)\]]+$/, '')
  if (!s || s.length > 2000) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null
    return u.href
  } catch {
    return null
  }
}
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

/**
 * Understands a few shortcuts typed straight into the "Add a task" box:
 *   Maths homework tomorrow 4pm !3 #school @School
 *   → title "Maths homework", due tomorrow 16:00, high priority, tag "school", list "School"
 *
 * today / tomorrow / tonight / mon…sun / next week / 25 Oct / 25/10
 * 4pm / 4:30pm / 16:00      !1 !2 !3 (low / medium / high)
 * #tag      @List (matches the start of a list name)
 * daily / weekly / monthly / yearly / every day|week|month|year / every 2 weeks
 * every mon / every monday and thursday / every weekday
 */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * `today` is the person's local date ('YYYY-MM-DD'); the server passes it in
 * for their timezone, the browser uses its own clock.
 */
export function parseQuickAdd(input, lists, today = localToday()) {
  let text = ` ${input} `
  const out = { title: '', hints: [] }
  const take = (re, fn) => {
    const m = text.match(re)
    if (m && fn(m) !== false) text = text.replace(m[0], ' ')
  }

  // web links: "Read this https://example.com/article" → a link on the task
  const links = []
  for (let i = 0; i < 20; i++) {
    let found = false
    take(/\s(https?:\/\/[^\s<>"']+)(?=\s)/i, (m) => {
      const url = cleanUrl(m[1])
      if (!url) return false
      links.push({ url, title: '' })
      found = true
    })
    if (!found) break
  }
  if (links.length) { out.links = links; out.hints.push(`🔗 ${links.length === 1 ? hostOf(links[0].url) : `${links.length} links`}`) }

  take(/\s!([1-3])(?=\s)/, (m) => {
    out.priority = Number(m[1])
    out.hints.push(['', 'Low', 'Medium', 'High'][out.priority] + ' priority')
  })

  const tags = []
  for (let i = 0; i < 10; i++) {
    let found = false
    take(/\s#([\p{L}\p{N}_-]{1,24})(?=\s)/u, (m) => { tags.push(m[1].toLowerCase()); found = true })
    if (!found) break
  }
  if (tags.length) { out.tags = tags; out.hints.push(tags.map((t) => `#${t}`).join(' ')) }

  take(/\s@([\p{L}\p{N}_-]{1,40})(?=\s)/u, (m) => {
    const q = m[1].toLowerCase()
    const l = lists.find((l) => l.name.toLowerCase().replace(/\s+/g, '').startsWith(q))
    if (!l) return false
    out.listId = l.id
    out.hints.push(`${l.emoji} ${l.name}`)
  })

  // repeats: "every 2 weeks", "every mon and thu", "every weekday", "daily"…
  const UNIT = { day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year' }
  const ADVERB = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year', annually: 'year' }
  take(/\s(daily|weekly|monthly|yearly|annually)(?=\s)/i, (m) => { out.repeat = { freq: ADVERB[m[1].toLowerCase()], interval: 1 } })
  if (!out.repeat) take(/\severy\s(?:(\d{1,3})\s)?(days?|weeks?|months?|years?)(?=\s)/i, (m) => {
    const n = Number(m[1] || 1)
    if (n < 1 || n > 365) return false
    out.repeat = { freq: UNIT[m[2].toLowerCase()], interval: n }
  })
  if (!out.repeat) take(/\severy\sweekday(?=\s)/i, () => { out.repeat = { freq: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] } })
  if (!out.repeat) take(/\severy\s((?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:,?\s(?:and\s)?|\s?&\s?)?)+)(?=\s)/i, (m) => {
    const days = [...m[1].toLowerCase().matchAll(/(sun|mon|tue|wed|thu|fri|sat)/g)].map((x) => DAYS.indexOf(x[1]))
    if (!days.length) return false
    out.repeat = { freq: 'week', interval: 1, weekdays: [...new Set(days)].sort((a, b) => a - b) }
  })
  if (out.repeat) out.hints.push(`↻ ${describeRepeat(out.repeat)}`)

  // time first, so "tonight" can default it
  take(/\s(?:at\s)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?=\s)/i, (m) => {
    let h = Number(m[1]) % 12
    if (m[3].toLowerCase() === 'pm') h += 12
    const min = Number(m[2] || 0)
    if (Number(m[1]) > 12 || min > 59) return false
    out.time = `${pad(h)}:${pad(min)}`
  })
  if (!out.time) take(/\s(?:at\s)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m) => { out.time = `${pad(Number(m[1]))}:${m[2]}` })

  take(/\s(today|tod)(?=\s)/i, () => { out.due = today })
  if (!out.due) take(/\s(tonight)(?=\s)/i, () => { out.due = today; out.time ||= '20:00' })
  if (!out.due) take(/\s(tomorrow|tmr|tmrw)(?=\s)/i, () => { out.due = addDays(today, 1) })
  if (!out.due) take(/\snext week(?=\s)/i, () => { out.due = addDays(today, 7) })
  if (!out.due) take(/\s(?:on\s)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?=\s)/i, (m) => {
    const want = DAYS.indexOf(m[1].toLowerCase())
    const now = weekday(today)
    out.due = addDays(today, ((want - now + 7) % 7) || 7)
  })
  if (!out.due) take(/\s(\d{1,2})\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?=\s)/i, (m) => {
    out.due = nextDate(Number(m[1]), MONTHS.indexOf(m[2].toLowerCase()), today)
    if (!out.due) return false
  })
  if (!out.due) take(/\s(\d{1,2})\/(\d{1,2})(?=\s)/, (m) => {
    out.due = nextDate(Number(m[1]), Number(m[2]) - 1, today)
    if (!out.due) return false
  })
  if (out.repeat && !out.due) {
    const wd = out.repeat.weekdays
    if (wd?.length) {
      const now = weekday(today)
      out.due = addDays(today, Math.min(...wd.map((d) => (d - now + 7) % 7)))
    } else out.due = today
  }
  if (out.time && !out.due) out.due = today

  if (out.due) out.hints.unshift(out.time ? `Due ${out.due === today ? 'today' : out.due} at ${out.time}` : `Due ${out.due === today ? 'today' : out.due}`)
  out.title = text.replace(/\s+/g, ' ').trim()
  return out
}

/** The next time this day and month comes round (this year, or next year if it's passed). */
function nextDate(day, month, today) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined
  const year = Number(today.slice(0, 4))
  let d = new Date(year, month, day)
  if (d.getMonth() !== month) return undefined
  if (toKey(d) < today) d = new Date(year + 1, month, day)
  return toKey(d)
}
