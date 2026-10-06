/** An on/off switch, like the ones in Reminders' details panel. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  )
}
