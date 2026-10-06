import { useState, type FormEvent } from 'react'
import { MAX_REMIND, REMIND_OPTIONS, describeRemind } from '../dates'
import { MenuItem } from './Popover'

const UNITS = [
  { key: 'min', label: 'minutes', mult: 1 },
  { key: 'hour', label: 'hours', mult: 60 },
  { key: 'day', label: 'days', mult: 1440 },
] as const
type Unit = (typeof UNITS)[number]['key']

/** Split a number of minutes into the biggest unit it fits exactly. */
function split(min: number): { n: number; unit: Unit } {
  if (min > 0 && min % 1440 === 0) return { n: min / 1440, unit: 'day' }
  if (min > 0 && min % 60 === 0) return { n: min / 60, unit: 'hour' }
  return { n: min || 30, unit: 'min' }
}

/**
 * Early reminder: the usual choices, plus "Custom…" for any amount of time
 * before the task (up to a week).
 */
export function RemindPicker({ value, onPick }: { value: number | null; onPick: (min: number | null) => void }) {
  const preset = REMIND_OPTIONS.some((o) => o.value === value)
  const [custom, setCustom] = useState(!preset)
  const start = split(value ?? 30)
  const [n, setN] = useState(String(start.n))
  const [unit, setUnit] = useState<Unit>(start.unit)
  const total = Number(n) * UNITS.find((u) => u.key === unit)!.mult
  const bad = !/^\d{1,4}$/.test(n.trim()) || total < 1 || total > MAX_REMIND

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!bad) onPick(total)
  }

  return (
    <div className="menu remind-picker" role="menu">
      {REMIND_OPTIONS.map((o) => (
        <MenuItem key={String(o.value)} label={o.value === null ? 'None' : o.label} selected={value === o.value && !custom} onClick={() => onPick(o.value)} />
      ))}
      <MenuItem label={!preset && value !== null ? `Custom: ${describeRemind(value)}` : 'Custom…'} selected={custom} onClick={() => setCustom(true)} />
      {custom && (
        <form className="remind-custom" onSubmit={submit}>
          <input
            className="input sm"
            inputMode="numeric"
            value={n}
            onChange={(e) => setN(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
            aria-label="How long before"
            aria-invalid={bad || undefined}
            autoFocus
          />
          <select className="input sm" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Unit">
            {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
          </select>
          <span className="remind-before">before</span>
          <button className="btn sm" disabled={bad}>Set</button>
          <p className={`help${bad ? ' bad' : ''}`}>{bad ? 'Pick between 1 minute and 7 days.' : describeRemind(total)}</p>
        </form>
      )}
    </div>
  )
}
