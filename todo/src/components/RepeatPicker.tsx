import { useState } from 'react'
import { REPEAT_PRESETS, describeRepeat, isPreset, type Freq, type Repeat } from '../repeat'
import { fromKey } from '../dates'
import { MenuItem } from './Popover'

export const RepeatIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8.5V7.5A2.5 2.5 0 0 1 6.5 5H15l-2.5-2.5M16 11.5v1a2.5 2.5 0 0 1-2.5 2.5H5l2.5 2.5" /></svg>
)

const UNITS: { value: Freq; one: string; many: string }[] = [
  { value: 'day', one: 'day', many: 'days' },
  { value: 'week', one: 'week', many: 'weeks' },
  { value: 'month', one: 'month', many: 'months' },
  { value: 'year', one: 'year', many: 'years' },
]
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Never / Daily / Weekly / Monthly / Yearly, or Custom:
 * every N days|weeks|months|years, on chosen weekdays, until a date.
 */
export function RepeatPicker({ value, due, weekStartsMonday, onPick }: {
  value: Repeat | null
  due: string | null
  weekStartsMonday: boolean
  onPick: (r: Repeat | null) => void
}) {
  const [custom, setCustom] = useState(!isPreset(value))
  const dueDay = due ? fromKey(due).getDay() : new Date().getDay()
  const [freq, setFreq] = useState<Freq>(value?.freq || 'week')
  const [interval, setEvery] = useState(value?.interval || 1)
  const [weekdays, setWeekdays] = useState<number[]>(value?.weekdays?.length ? value.weekdays : [dueDay])
  const [until, setUntil] = useState(value?.until || '')

  if (!custom) {
    return (
      <div className="menu" role="menu" aria-label="Repeat">
        {REPEAT_PRESETS.map((p) => (
          <MenuItem
            key={p.label}
            icon={p.value ? <RepeatIcon /> : undefined}
            label={p.label}
            selected={isPreset(value) && (value?.freq ?? null) === (p.value?.freq ?? null)}
            onClick={() => onPick(p.value)}
          />
        ))}
        <div className="menu-sep" />
        <MenuItem icon={<RepeatIcon />} label="Custom…" sub={!isPreset(value) ? describeRepeat(value) : undefined} selected={!isPreset(value)} onClick={() => setCustom(true)} />
      </div>
    )
  }

  const order = weekStartsMonday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]
  const draft: Repeat = {
    freq,
    interval: Math.max(1, Math.min(365, interval || 1)),
    ...(freq === 'week' && weekdays.length ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {}),
    ...(until ? { until } : {}),
  }
  return (
    <form className="repeat-custom" onSubmit={(e) => { e.preventDefault(); onPick(draft) }}>
      <div className="repeat-row">
        <span>Every</span>
        <input className="input sm num" type="number" min={1} max={365} value={interval} onChange={(e) => setEvery(Number(e.target.value))} aria-label="How often" />
        <select className="input sm" value={freq} onChange={(e) => setFreq(e.target.value as Freq)} aria-label="Unit">
          {UNITS.map((u) => <option key={u.value} value={u.value}>{interval === 1 ? u.one : u.many}</option>)}
        </select>
      </div>
      {freq === 'week' && (
        <div className="weekday-row" role="group" aria-label="On these days">
          {order.map((d) => {
            const on = weekdays.includes(d)
            return (
              <button
                type="button"
                key={d}
                className={on ? 'on' : ''}
                aria-pressed={on}
                aria-label={DAY_NAMES[d]}
                onClick={() => setWeekdays(on ? (weekdays.length > 1 ? weekdays.filter((x) => x !== d) : weekdays) : [...weekdays, d])}
              >
                {DAY_LETTERS[d]}
              </button>
            )
          })}
        </div>
      )}
      <label className="repeat-row">
        <span>End repeat</span>
        <input className="input sm" type="date" value={until} min={due || undefined} onChange={(e) => setUntil(e.target.value)} aria-label="End repeat date" />
        {until && <button type="button" className="btn quiet sm" onClick={() => setUntil('')}>Never</button>}
      </label>
      <p className="help repeat-summary">{describeRepeat(draft)}</p>
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={() => setCustom(false)}>Back</button>
        <span className="spacer" />
        <button className="btn sm">Done</button>
      </div>
    </form>
  )
}
