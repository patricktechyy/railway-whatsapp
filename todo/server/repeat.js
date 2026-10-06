/**
 * Repeating tasks, shared by the server (to create the next copy when one is
 * finished) and the browser (to show upcoming occurrences on the calendar).
 *
 * repeat = { freq: 'day'|'week'|'month'|'year', interval: 1-365,
 *            weekdays?: number[] (0=Sun … 6=Sat, weekly only), until?: 'YYYY-MM-DD'|null }
 * Dates are local calendar days, 'YYYY-MM-DD'.
 */

export const FREQS = ['day', 'week', 'month', 'year']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const pad = (n) => String(n).padStart(2, '0')
const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return { y, m: m - 1, d } }
const key = (y, m, d) => {
  const dt = new Date(y, m, d)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate()
const weekday = (k) => { const { y, m, d } = parse(k); return new Date(y, m, d).getDay() }
const addDays = (k, n) => { const { y, m, d } = parse(k); return key(y, m, d + n) }

/** Returns a clean repeat object, or null. Throws a message string if it's invalid. */
export function cleanRepeat(v) {
  if (v === null || v === undefined || v === '' || v === false) return null
  if (typeof v !== 'object') throw 'Invalid repeat'
  const freq = FREQS.includes(v.freq) ? v.freq : null
  if (!freq) throw 'Repeat must be daily, weekly, monthly or yearly'
  const interval = Number(v.interval ?? 1)
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw 'Repeat every 1–365'
  const out = { freq, interval }
  if (freq === 'week' && Array.isArray(v.weekdays)) {
    const w = [...new Set(v.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
    if (w.length) out.weekdays = w
  }
  if (v.until) {
    if (!DATE_RE.test(v.until)) throw 'End repeat date must look like 2026-12-31'
    out.until = v.until
  }
  return out
}

/** The first occurrence strictly after `due`, or null once past `until`. */
export function nextOccurrence(due, repeat) {
  if (!due || !repeat) return null
  const { y, m, d } = parse(due)
  const n = repeat.interval || 1
  let next
  if (repeat.freq === 'day') next = key(y, m, d + n)
  else if (repeat.freq === 'week') {
    const days = repeat.weekdays?.length ? repeat.weekdays : null
    if (!days) next = key(y, m, d + 7 * n)
    else {
      // later weekdays in this week, else the first chosen weekday `n` weeks on
      const wd = weekday(due)
      const later = days.find((x) => x > wd)
      if (later !== undefined) next = addDays(due, later - wd)
      else {
        const weekStart = addDays(due, -wd) // Sunday of this week
        next = addDays(weekStart, 7 * n + days[0])
      }
    }
  } else if (repeat.freq === 'month') {
    // keep the original day of the month, clamped for short months (31st → 30th/28th)
    const total = m + n
    const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12
    next = key(ny, nm, Math.min(d, daysIn(ny, nm)))
  } else if (repeat.freq === 'year') {
    next = key(y + n, m, Math.min(d, daysIn(y + n, m)))
  } else return null
  if (repeat.until && next > repeat.until) return null
  return next
}

/** All occurrences after `due` up to and including `last` (for the calendar). */
export function occurrencesBetween(due, repeat, first, last, max = 60) {
  const out = []
  let k = due
  while (out.length < max) {
    k = nextOccurrence(k, repeat)
    if (!k || k > last) break
    if (k >= first) out.push(k)
  }
  return out
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const UNIT = { day: 'day', week: 'week', month: 'month', year: 'year' }
const PRESET = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }

/** "Daily", "Every 2 weeks on Mon, Thu", "Monthly until 2026-12-31" */
export function describeRepeat(repeat) {
  if (!repeat) return 'Never'
  const n = repeat.interval || 1
  let s = n === 1 ? PRESET[repeat.freq] : `Every ${n} ${UNIT[repeat.freq]}s`
  if (repeat.freq === 'week' && repeat.weekdays?.length) {
    const names = repeat.weekdays.map((w) => DAY_NAMES[w]).join(', ')
    s = n === 1 ? `Every ${names}` : `${s} on ${names}`
  }
  if (repeat.until) s += ` until ${repeat.until}`
  return s
}
