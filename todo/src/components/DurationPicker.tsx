import { useState, type FormEvent } from 'react'
import { formatTime } from '../dates'
import { MenuItem } from './Popover'
import { Select } from './Select'

/** How long a task takes, in minutes (optional). Its calendar event is that long. */
export const DURATIONS = [15, 30, 45, 60, 90, 120, 180]
export const MIN_DURATION = 5
export const MAX_DURATION = 24 * 60

/** "45 min", "1 h", "1 h 30" ("1 h 30 min" when long). */
export function describeDuration(min: number | null | undefined, { long = false } = {}): string {
  if (!min) return ''
  const h = Math.floor(min / 60), m = min % 60
  if (!h) return `${m} min`
  if (!m) return `${h} h`
  return long ? `${h} h ${m} min` : `${h} h ${m}`
}

/** When it ends, as a clock time ("7:30 PM"), for a task with a start time and a length. */
export function endTime(time: string | null | undefined, min: number | null | undefined): string | null {
  if (!time || !min) return null
  const [h, m] = time.split(':').map(Number)
  const end = (h * 60 + m + min) % (24 * 60)
  return formatTime(`${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`)
}

export const HourglassIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 2.5h9M5.5 17.5h9" /><path d="M6.5 2.5c0 3.5 3.5 4.5 3.5 7.5s-3.5 4-3.5 7.5M13.5 2.5c0 3.5-3.5 4.5-3.5 7.5s3.5 4 3.5 7.5" /></svg>
)

/** The usual lengths, "Not set", and a custom one (minutes or hours). */
export function DurationPicker({ value, time, onPick }: { value: number | null; time?: string | null; onPick: (min: number | null) => void }) {
  const preset = value === null || DURATIONS.includes(value)
  const [custom, setCustom] = useState(!preset)
  const [n, setN] = useState(value && !preset ? String(value % 60 ? value : value / 60) : '')
  const [unit, setUnit] = useState<'min' | 'hour'>(value && !preset && !(value % 60) ? 'hour' : 'min')
  const total = Math.round(Number(n.replace(',', '.')) * (unit === 'hour' ? 60 : 1))
  const bad = !/^\d{1,4}([.,]\d{1,2})?$/.test(n.trim()) || total < MIN_DURATION || total > MAX_DURATION
  const submit = (e: FormEvent) => { e.preventDefault(); if (!bad) onPick(total) }
  const until = (min: number) => (time ? `until ${endTime(time, min)}` : undefined)
  return (
    <div className="menu remind-picker" role="menu">
      <MenuItem label="Not set" sub={time ? 'Calendar shows 30 min' : undefined} selected={value === null && !custom} onClick={() => onPick(null)} />
      {DURATIONS.map((d) => <MenuItem key={d} label={describeDuration(d, { long: true })} sub={until(d)} selected={value === d && !custom} onClick={() => onPick(d)} />)}
      <MenuItem label={!preset && value ? `Custom: ${describeDuration(value, { long: true })}` : 'Custom…'} selected={custom} onClick={() => setCustom(true)} />
      {custom && (
        <form className="remind-custom" onSubmit={submit}>
          <input className="input sm" inputMode="decimal" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d.,]/g, '').slice(0, 6))} aria-label="How long" aria-invalid={(n !== '' && bad) || undefined} autoFocus />
          <Select className="input sm" value={unit} onChange={(e) => setUnit(e.target.value as 'min' | 'hour')} aria-label="Unit">
            <option value="min">minutes</option>
            <option value="hour">hours</option>
          </Select>
          <button className="btn sm" disabled={bad}>Set</button>
          <p className={`help${n !== '' && bad ? ' bad' : ''}`}>{n !== '' && bad ? 'Between 5 minutes and 24 hours.' : n ? describeDuration(total, { long: true }) : 'Like 40 minutes or 2.5 hours'}</p>
        </form>
      )}
    </div>
  )
}
