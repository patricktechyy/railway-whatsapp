import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A dropdown that looks the same everywhere (the browser's own <select> menu
 * looks different on every system and ignores the app's theme).
 *
 * Used like a <select>: same <option>/<optgroup> children, and onChange gets
 * `{ target: { value } }`, so swapping one for the other is a one-word change.
 */
type Opt = { value: string; label: ReactNode; text: string; disabled?: boolean; group?: string }

const textOf = (n: ReactNode): string =>
  typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : isValidElement(n) ? textOf((n.props as any).children) : ''

function collect(children: ReactNode, group?: string, out: Opt[] = []) {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<any>
    if (el.type === 'option') {
      const text = textOf(el.props.children)
      out.push({ value: String(el.props.value ?? text), label: el.props.children, text, disabled: !!el.props.disabled, group })
    } else if (el.type === 'optgroup') collect(el.props.children, el.props.label, out)
    else if (el.type === Fragment) collect(el.props.children, group, out)
  })
  return out
}

interface Props {
  value: string | number
  onChange: (e: { target: { value: string } }) => void
  children: ReactNode
  className?: string
  disabled?: boolean
  'aria-label'?: string
  title?: string
}

export function Select({ value, onChange, children, className = 'input', disabled, title, ...rest }: Props) {
  const opts = useMemo(() => collect(children), [children])
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null)
  const id = useId()
  const cur = opts.find((o) => o.value === String(value))
  const typed = useRef({ s: '', t: 0 })

  const show = () => {
    if (disabled || !opts.length) return
    setActive(Math.max(0, opts.findIndex((o) => o.value === String(value))))
    setOpen(true)
  }
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus() }
  const pick = (o: Opt | undefined) => {
    if (!o || o.disabled) return
    if (o.value !== String(value)) onChange({ target: { value: o.value } })
    close()
  }
  const move = (from: number, step: number) => {
    for (let i = 1; i <= opts.length; i++) {
      const j = (from + step * i + opts.length * 2) % opts.length
      if (!opts[j].disabled) return j
    }
    return from
  }

  // place it under the button (above, near the bottom of the screen), and follow it
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const b = btn.current?.getBoundingClientRect()
      if (!b) return
      const want = Math.min(menu.current?.scrollHeight || 300, 320)
      const below = window.innerHeight - b.bottom - 12, above = b.top - 12
      const up = below < Math.min(want, 180) && above > below
      const maxH = Math.max(120, Math.min(320, up ? above : below))
      const width = Math.min(Math.max(b.width, 180), window.innerWidth - 16)
      const left = Math.max(8, Math.min(b.left, window.innerWidth - width - 8))
      const top = up ? b.top - 6 - Math.min(want, maxH) : b.bottom + 6
      setPos({ left, top, width, maxH })
    }
    place()
    let f = 0
    const follow = (e: Event) => { if (menu.current?.contains(e.target as Node)) return; if (!f) f = requestAnimationFrame(() => { f = 0; place() }) }
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => { cancelAnimationFrame(f); window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true) }
  }, [open])

  // outside click closes; Esc closes the menu only (not the dialog behind it)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (menu.current?.contains(t) || btn.current?.contains(t)) return
      close(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', esc, true) }
  }, [open])

  // keep the highlighted choice in view
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, pos])

  const onKey = (e: ReactKeyboardEvent) => {
    const k = e.key
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); show() }
      return
    }
    if (k === 'ArrowDown') { e.preventDefault(); setActive((a) => move(a, 1)) }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive((a) => move(a, -1)) }
    else if (k === 'Home') { e.preventDefault(); setActive(move(-1, 1)) }
    else if (k === 'End') { e.preventDefault(); setActive(move(opts.length, -1)) }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(opts[active]) }
    else if (k === 'Tab') close(false)
    else if (k.length === 1) {
      // type a letter or two to jump to a choice
      const now = Date.now(), t = typed.current
      t.s = now - t.t < 700 ? t.s + k.toLowerCase() : k.toLowerCase(); t.t = now
      const i = opts.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(t.s))
      if (i >= 0) setActive(i)
    }
  }

  // inside a modal dialog the menu has to live in the dialog, or it'd sit behind it
  const host = open ? (btn.current?.closest('dialog[open]') as HTMLElement | null) || document.body : null
  let lastGroup: string | undefined

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${className} select-btn`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={rest['aria-label']}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        <span className="select-value">{cur ? cur.label : ''}</span>
      </button>
      {open && host && createPortal(
        <ul
          ref={menu}
          id={id}
          role="listbox"
          className="select-menu"
          aria-label={rest['aria-label']}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: pos?.width, maxHeight: pos?.maxH }}
        >
          {opts.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null
            lastGroup = o.group
            return (
              <Fragment key={`${o.group || ''}:${o.value}`}>
                {head && <li className="select-group" role="presentation">{head}</li>}
                <li
                  data-i={i}
                  role="option"
                  aria-selected={o.value === String(value)}
                  aria-disabled={o.disabled || undefined}
                  className={`select-opt${i === active ? ' active' : ''}${o.value === String(value) ? ' on' : ''}`}
                  onPointerEnter={() => !o.disabled && setActive(i)}
                  onClick={() => pick(o)}
                >
                  <span>{o.label}</span>
                  {o.value === String(value) && (
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" /></svg>
                  )}
                </li>
              </Fragment>
            )
          })}
        </ul>,
        host,
      )}
    </>
  )
}
