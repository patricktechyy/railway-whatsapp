import type { ReactNode } from 'react'

export const FlagIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 17.5V3.5h9l-2 3.5 2 3.5H5" /></svg>
export const BellIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13zM8.5 17.5h3" /></svg>
export const ListIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9" /><circle cx="4" cy="5.5" r="1" /><circle cx="4" cy="10" r="1" /><circle cx="4" cy="14.5" r="1" /></svg>

/** A pill button that opens a popover, with an optional × to clear it (like Reminders' chips). */
export function Chip({ icon, label, active, onClick, onClear, anchorRef, title }: {
  icon: ReactNode; label?: string; active: boolean; onClick: () => void; onClear?: () => void
  anchorRef: (el: HTMLButtonElement | null) => void; title: string
}) {
  return (
    <span className={`tchip${active ? ' on' : ''}`}>
      <button type="button" className="chip-main" onClick={onClick} ref={anchorRef} aria-label={title} title={title}>
        {icon}{label && <span>{label}</span>}
      </button>
      {active && onClear && (
        <button type="button" className="chip-x" onClick={onClear} aria-label={`Clear ${title.toLowerCase()}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
        </button>
      )}
    </span>
  )
}

