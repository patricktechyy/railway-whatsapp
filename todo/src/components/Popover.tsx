import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  width?: number
  label: string
}

/**
 * A small floating panel anchored to a button (date, time, repeat…).
 * Opens below the button, or above it near the bottom of the screen.
 * Closes on outside click or Esc (without also closing whatever is behind it).
 */
export function Popover({ anchor, onClose, children, width = 260, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const h = ref.current!.offsetHeight
      const w = Math.min(width, window.innerWidth - 16)
      let top = a.bottom + 6
      if (top + h > window.innerHeight - 8 && a.top - h - 6 > 8) top = a.top - h - 6
      const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8))
      setPos({ left, top: Math.max(8, top) })
    }
    place()
    // follow the button while scrolling, at most once per frame
    let frame = 0
    const follow = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place() }) }
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', follow, true)
    }
  }, [anchor, width])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onClose()
      anchor?.focus()
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label={label}
      data-popover
      style={{ width: Math.min(width, window.innerWidth - 16), left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** One choice in a popover menu, with an optional second line and a tick when selected. */
export function MenuItem({ icon, label, sub, selected, onClick, danger }: {
  icon?: ReactNode
  label: ReactNode
  sub?: string
  selected?: boolean
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button type="button" className={`menu-item${selected ? ' on' : ''}${danger ? ' danger' : ''}`} onClick={onClick} role="menuitemradio" aria-checked={!!selected}>
      <span className="menu-icon" aria-hidden="true">{icon}</span>
      <span className="menu-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
      {selected && <svg className="menu-tick" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5 8.5 14 15 7" /></svg>}
    </button>
  )
}

/** A popover that belongs to one button: `usePopover()` gives the ref, open state and toggler. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [open, setOpen] = useState(false)
  return { ref: setEl, anchor: el, open, toggle: () => setOpen((o) => !o), close: () => setOpen(false) }
}
