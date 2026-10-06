import { addDays, formatDay, fromKey, MONTHS, todayKey, WEEKDAYS } from '../dates'
import { MenuItem } from './Popover'

export const CalendarIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="3" /><path d="M3 8h14M7 2.5v3M13 2.5v3" /></svg>
)

const long = (k: string) => { const d = fromKey(k); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}` }

/** Today / Tomorrow / Next week / any date, or None. */
export function DatePicker({ value, onPick }: { value: string | null; onPick: (d: string | null) => void }) {
  const today = todayKey()
  const quick = [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: 'This weekend', value: addDays(today, (6 - fromKey(today).getDay() + 7) % 7 || 7) },
    { label: 'Next week', value: addDays(today, 7) },
  ]
  return (
    <div className="menu" role="menu" aria-label="Date">
      <MenuItem label="None" selected={!value} onClick={() => onPick(null)} />
      {quick.map((q) => (
        <MenuItem key={q.label} icon={<CalendarIcon />} label={q.label} sub={long(q.value)} selected={value === q.value} onClick={() => onPick(q.value)} />
      ))}
      <div className="menu-sep" />
      <label className="menu-custom">
        <span className="sr-only">Pick a date</span>
        <input className="input sm" type="date" value={value || ''} onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="Pick a date" />
      </label>
      {value && !quick.some((q) => q.value === value) && <p className="help menu-note">Set to {formatDay(value)}</p>}
    </div>
  )
}
