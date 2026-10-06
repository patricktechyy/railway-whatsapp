import type { Task } from './types'

/** Dates are stored as local calendar days, "YYYY-MM-DD", never as UTC instants. */
export const pad = (n: number) => String(n).padStart(2, '0')
export const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const todayKey = () => toKey(new Date())
export const addDays = (k: string, n: number) => {
  const d = fromKey(k)
  d.setDate(d.getDate() + n)
  return toKey(d)
}
export const daysBetween = (a: string, b: string) => Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / 864e5)

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "4pm" / "4:30pm", or with `long` "4:00 PM" (as in the time picker). */
export function formatTime(t: string, long = false) {
  const [h, m] = t.split(':').map(Number)
  const h12 = h % 12 || 12
  if (long) return `${h12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`
  return `${h12}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`
}

/** "Today", "Tomorrow", "Yesterday", "Fri", or "Mon 6 Oct". */
export function formatDay(k: string) {
  const diff = daysBetween(todayKey(), k)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  const d = fromKey(k)
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()]
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${sameYear ? '' : ` ${d.getFullYear()}`}`
}

export function formatDue(t: Pick<Task, 'due' | 'time'>) {
  if (!t.due) return ''
  return t.time ? `${formatDay(t.due)}, ${formatTime(t.time)}` : formatDay(t.due)
}

/** When the task is due, as a timestamp. Date-only tasks count as due at the end of that day. */
export function dueAt(t: Pick<Task, 'due' | 'time'>) {
  if (!t.due) return null
  const d = fromKey(t.due)
  if (t.time) {
    const [h, m] = t.time.split(':').map(Number)
    d.setHours(h, m)
  } else d.setHours(23, 59, 59)
  return d.getTime()
}

/** When a reminder should go off. Date-only tasks are reminded relative to 9am that day. */
export function remindAt(t: Pick<Task, 'due' | 'time' | 'remind'>) {
  if (!t.due || t.remind === null) return null
  const d = fromKey(t.due)
  const [h, m] = (t.time || '09:00').split(':').map(Number)
  d.setHours(h, m)
  return d.getTime() - t.remind * 60e3
}

export const isOverdue = (t: Task) => !t.done && !!t.due && (dueAt(t) as number) < Date.now()

/** The longest early reminder the server accepts: one week. */
export const MAX_REMIND = 7 * 24 * 60

/** "At due time", "45 minutes before", "2 hours before", "1 h 30 min before", "3 days before"… */
export function describeRemind(min: number | null | undefined, { short = false } = {}): string {
  if (min === null || min === undefined) return short ? '' : 'No reminder'
  if (min === 0) return 'At due time'
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60
  let text
  if (min % 10080 === 0) text = plural(min / 10080, 'week')
  else if (min % 1440 === 0) text = plural(d, 'day')
  else if (min % 60 === 0 && min < 1440) text = plural(h, 'hour')
  else if (min < 60) text = plural(m, 'minute')
  else text = [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ')
  return short ? text : `${text} before`
}

export const REMIND_OPTIONS: { value: number | null; label: string }[] = [
  null, 0, 5, 10, 15, 30, 60, 120, 24 * 60, 2 * 24 * 60, 7 * 24 * 60,
].map((value) => ({ value, label: describeRemind(value) }))
