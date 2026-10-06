import { useState } from 'react'
import { formatTime } from '../dates'
import { MenuItem } from './Popover'
import { TimeInput } from './TimeInput'

const PRESETS = [
  { value: '09:00', sub: 'Morning' },
  { value: '12:00', sub: 'Midday' },
  { value: '15:00', sub: 'Afternoon' },
  { value: '18:00', sub: 'Evening' },
  { value: '21:00', sub: 'Night' },
]

export const ClockIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></svg>
)

/** Pick a time the way Reminders does: None, five named times, or your own. */
export function TimePicker({ value, onPick }: { value: string | null; onPick: (t: string | null) => void }) {
  const isPreset = !value || PRESETS.some((p) => p.value === value)
  const [custom, setCustom] = useState(!isPreset)

  return (
    <div className="menu" role="menu" aria-label="Time">
      <MenuItem label="None" selected={!value} onClick={() => onPick(null)} />
      {PRESETS.map((p) => (
        <MenuItem key={p.value} icon={<ClockIcon />} label={formatTime(p.value, true)} sub={p.sub} selected={value === p.value} onClick={() => onPick(p.value)} />
      ))}
      <div className="menu-sep" />
      {custom ? (
        <div className="menu-custom">
          <TimeInput value={value} onSubmit={onPick} />
        </div>
      ) : (
        <MenuItem icon={<ClockIcon />} label={!isPreset && value ? formatTime(value, true) : 'Custom…'} sub={!isPreset && value ? 'Custom' : undefined} selected={!isPreset} onClick={() => setCustom(true)} />
      )}
    </div>
  )
}
