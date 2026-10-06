/**
 * Turn a wall-clock time in someone's timezone into a real instant, without a
 * timezone library. The server runs in UTC on Railway, but "remind me at 9am"
 * means 9am where the person is.
 */

const fmtCache = new Map()
function parts(ms, tz) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  const o = {}
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value
  return o
}

/** Minutes the zone is ahead of UTC at instant `ms` (Jakarta: +420). */
export function offsetMinutes(ms, tz) {
  const p = parts(ms, tz)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000)
}

export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** 'YYYY-MM-DD' + 'HH:MM' in `tz` → epoch milliseconds. */
export function zonedTime(dateKey, time, tz = 'UTC') {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  if (!validTz(tz)) return guess
  // two passes settle DST edges
  let t = guess - offsetMinutes(guess, tz) * 60000
  t = guess - offsetMinutes(t, tz) * 60000
  return t
}

/** Today's date ('YYYY-MM-DD') where the person is. */
export function todayIn(tz, now = Date.now()) {
  if (!validTz(tz)) tz = 'UTC'
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now))
  const o = Object.fromEntries(p.map((x) => [x.type, x.value]))
  return `${o.year}-${o.month}-${o.day}`
}
