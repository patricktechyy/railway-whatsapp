import { useState, type FormEvent } from 'react'
import { MONTHS, WEEKDAYS, addDays, describeRemind, formatTime, fromKey, pad, todayKey, toKey } from '../dates'
import type { Task, WaRemind } from '../types'

/** How Buddy reaches people here (set from the account once it's known): from the bot's own number, where you just reply "done", or in "Message yourself" with "td done". */
export const waStyle = { bot: false }
import { MenuItem } from './Popover'

/** A speech bubble: WhatsApp Buddy. */
export const WaIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 15.8 5.4 12.6A6.5 6.5 0 1 1 7.8 15z" /><path d="M7.5 9.5h.01M10 9.5h.01M12.5 9.5h.01" /></svg>
)

const at = (day: string, hm: string) => { const [h, m] = hm.split(':').map(Number); const d = fromKey(day); d.setHours(h, m, 0, 0); return d.getTime() }
/** Same "which version of the reminder" key as the server, so we can tell when it has gone out. */
const sigOf = (t: Pick<Task, 'due' | 'time' | 'wa'>) => (typeof t.wa?.at === 'number' ? `at:${t.wa.at}` : `b:${t.due}|${t.time}|${t.wa?.before}`)
export const waSent = (t: Pick<Task, 'due' | 'time' | 'wa'>) => !!t.wa?.sent && t.wa.sent === sigOf(t)

/** "8:15 PM", "Tomorrow 9:00 AM", "Mon 6 Oct, 9:00 AM" */
export function whenLabel(ms: number) {
  const d = new Date(ms)
  const k = toKey(d)
  const time = formatTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
  if (k === todayKey()) return time
  if (k === addDays(todayKey(), 1)) return `Tomorrow ${time}`
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}, ${time}`
}

/** What the WhatsApp reminder is, in words (short, for chips and rows). */
export function describeWa(t: Pick<Task, 'due' | 'time' | 'wa'>): string | undefined {
  const wa = t.wa
  if (!wa) return undefined
  if (waSent(t)) return 'Sent ✓'
  if (typeof wa.at === 'number') return whenLabel(wa.at)
  if (typeof wa.before === 'number') {
    if (!t.due) return 'Needs a date'
    if (wa.before === 0) return t.time ? 'At due time' : 'On the day, 9 AM'
    return describeRemind(wa.before)
  }
  return undefined
}

/**
 * "💬 WhatsApp me": when WhatsApp Buddy should message you about this task.
 * Relative choices follow the task if its date or time changes.
 */
export function WaPicker({ task, onPick }: { task: Pick<Task, 'due' | 'time' | 'wa'>; onPick: (wa: WaRemind | null) => void }) {
  const now = new Date()
  const today = todayKey()
  const hour = now.getHours() + now.getMinutes() / 60
  const [custom, setCustom] = useState(false)
  const def = new Date(Date.now() + 3600e3)
  const [value, setValue] = useState(`${toKey(def)}T${pad(def.getHours())}:00`)
  const cur = task.wa
  const is = (wa: WaRemind) => (wa.before !== undefined ? cur?.before === wa.before : false)
  const presets: { label: string; sub?: string; wa: WaRemind }[] = []
  if (task.due) {
    presets.push({ label: task.time ? 'At due time' : 'On the day', sub: task.time ? undefined : '9:00 AM', wa: { before: 0 } })
    if (task.time) presets.push({ label: '15 minutes before', wa: { before: 15 } }, { label: '1 hour before', wa: { before: 60 } })
    presets.push({ label: '1 day before', wa: { before: 1440 } })
  }
  presets.push({ label: 'In 1 hour', sub: whenLabel(Date.now() + 3600e3), wa: { at: Date.now() + 3600e3 } })
  if (hour < 18.5) presets.push({ label: 'This evening', sub: '7:00 PM', wa: { at: at(today, '19:00') } })
  else if (hour < 20.5) presets.push({ label: 'Tonight', sub: '9:00 PM', wa: { at: at(today, '21:00') } })
  presets.push({ label: 'Tomorrow morning', sub: '9:00 AM', wa: { at: at(addDays(today, 1), '09:00') } })

  const ms = new Date(value).getTime()
  const bad = !Number.isFinite(ms) || ms < Date.now() - 60e3
  const submit = (e: FormEvent) => { e.preventDefault(); if (!bad) onPick({ at: ms }) }

  return (
    <div className="menu wa-picker" role="menu">
      <p className="menu-note help">🤖 WhatsApp Buddy will message you{waStyle.bot ? ' from its own number' : ''}, and you can answer <b>{waStyle.bot ? 'done' : 'td done'}</b> or <b>{waStyle.bot ? 'snooze 1h' : 'td snooze 1h'}</b>.</p>
      {presets.map((p) => <MenuItem key={p.label} label={p.label} sub={p.sub} selected={is(p.wa)} onClick={() => onPick(p.wa)} />)}
      {custom ? (
        <form className="menu-custom" onSubmit={submit}>
          <input className="input sm" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} aria-label="When" aria-invalid={bad} autoFocus />
          <button className="btn sm" disabled={bad}>Set</button>
        </form>
      ) : (
        <MenuItem label="Custom…" selected={typeof cur?.at === 'number' && !presets.some((p) => p.wa.at === cur.at)} sub={typeof cur?.at === 'number' ? whenLabel(cur.at) : undefined} onClick={() => setCustom(true)} />
      )}
      {cur && <><div className="menu-sep" /><MenuItem label="Don’t WhatsApp me" danger onClick={() => onPick(null)} /></>}
    </div>
  )
}
