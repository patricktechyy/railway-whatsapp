import { useEffect, useState, type ReactNode } from 'react'

/**
 * Rolls its content up and down smoothly (a grid-rows transition, so any
 * height works). Once fully open it stops clipping, so things dragged inside
 * it aren't cut off; while closed its content can't be tabbed into.
 */
export function Collapsible({ open, children, className = '' }: { open: boolean; children: ReactNode; className?: string }) {
  const [settled, setSettled] = useState(open)
  useEffect(() => { if (!open) setSettled(false) }, [open])
  return (
    <div
      className={`collapsible${open ? ' open' : ''}${open && settled ? ' settled' : ''} ${className}`}
      onTransitionEnd={(e) => { if (e.target === e.currentTarget && open) setSettled(true) }}
      inert={!open}
    >
      <div className="collapsible-inner">{children}</div>
    </div>
  )
}
