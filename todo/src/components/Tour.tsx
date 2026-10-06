import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface TourStep {
  icon: string
  title: string
  body: ReactNode
  /** Go here first (the "teleport"). */
  go?: () => void
  /** What to highlight; the first visible match. Missing → a centred card. */
  target?: string
  /** Shown instead when the target isn't there (e.g. no tasks yet), so the step still makes sense. */
  demo?: ReactNode
}

type Rect = { top: number; left: number; width: number; height: number }

/** The first element matching `sel` that's actually on screen (not in a closed phone menu). */
function findVisible(sel: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth) return el
  }
  return null
}

/**
 * A guided tour: each step can take you to a page and spotlight part of it,
 * with Next / Back / Skip (or ← → and Esc).
 */
export function Tour({ steps, onEnd }: { steps: TourStep[]; onEnd: () => void }) {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [missing, setMissing] = useState(false) // this step's target isn't on the page
  const [shown, setShown] = useState(false) // fades in once, then stays: the card never vanishes between steps
  const card = useRef<HTMLDivElement>(null)
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null)
  const [sheetTop, setSheetTop] = useState(false) // phones: the card goes to the top when the spotlight is low
  const step = steps[i]
  const last = i === steps.length - 1

  useEffect(() => { const t = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(t) }, [])

  // Go to the step's page, then look (briefly) for its target. The card shows the new
  // step straight away; the spotlight glides over once the target is found. If it never
  // turns up (say, no tasks yet), the card sits in the middle with an example instead.
  useEffect(() => {
    setMissing(false)
    step.go?.()
    if (!step.target) { setRect(null); return }
    let tries = 0
    let el: HTMLElement | null = null
    const measure = () => {
      if (!el) return // still looking
      if (!el.isConnected) el = findVisible(step.target!)
      if (!el) { setRect(null); setMissing(true); return }
      const r = el.getBoundingClientRect()
      const pad = 6
      setRect({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 })
    }
    const look = () => {
      el = findVisible(step.target!)
      if (el) {
        clearInterval(poll)
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        measure()
      } else if (++tries > 12) {
        clearInterval(poll)
        setRect(null)
        setMissing(true)
      }
    }
    // (first look after a beat, so the old page's elements are gone if the step changed page)
    const poll = window.setInterval(look, 80)
    // keep the spotlight on it while things move (scrolling, resizing, live updates)
    const follow = window.setInterval(measure, 250)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      clearInterval(poll)
      clearInterval(follow)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [i]) // eslint-disable-line react-hooks/exhaustive-deps

  // put the card beside the highlight, or centred / at the bottom on phones
  useLayoutEffect(() => {
    const c = card.current
    if (!c) return
    const w = c.offsetWidth, h = c.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, m = 12
    if (!rect || vw < 640) { setCardPos(null); setSheetTop(!!rect && rect.top + rect.height / 2 > vh / 2); return }
    const clampTop = (t: number) => Math.max(m, Math.min(vh - h - m, t))
    const clampLeft = (l: number) => Math.max(m, Math.min(vw - w - m, l))
    if (rect.left + rect.width + m + w < vw) setCardPos({ left: rect.left + rect.width + m, top: clampTop(rect.top) })
    else if (rect.left - m - w > 0) setCardPos({ left: rect.left - m - w, top: clampTop(rect.top) })
    else if (rect.top + rect.height + m + h < vh) setCardPos({ left: clampLeft(rect.left), top: rect.top + rect.height + m })
    else if (rect.top - m - h > 0) setCardPos({ left: clampLeft(rect.left), top: rect.top - m - h })
    else setCardPos(null)
  }, [rect, i, missing])

  const next = useCallback(() => (last ? onEnd() : setI((n) => n + 1)), [last, onEnd])
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return
      // a dialog or menu opened on top of the tour gets the keys first
      if (document.querySelector('dialog[open], [data-popover]')) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEnd() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [next, back, onEnd])

  useEffect(() => { card.current?.querySelector<HTMLButtonElement>('.tour-next')?.focus({ preventScroll: true }) }, [i])

  return createPortal(
    <div className={`tour${rect ? ' has-spot' : ''}`} data-tour-step={i}>
      {rect ? <div className="tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} aria-hidden="true" /> : <div className="tour-dim" aria-hidden="true" />}
      <div
        ref={card}
        className={`tour-card${cardPos ? '' : rect && window.innerWidth < 640 ? ` sheet${sheetTop ? ' top' : ''}` : ' centred'}${shown ? ' in' : ''}`}
        style={cardPos ? { top: cardPos.top, left: cardPos.left } : undefined}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
      >
        <div className="tour-icon" aria-hidden="true">{step.icon}</div>
        <h3 id="tour-title">{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        {missing && step.demo && <div className="tour-demo" aria-hidden="true">{step.demo}</div>}
        <div className="tour-foot">
          <div className="tour-dots" aria-label={`Step ${i + 1} of ${steps.length}`}>
            {steps.map((_, k) => <i key={k} className={k === i ? 'on' : k < i ? 'past' : ''} />)}
          </div>
          {!last && <button type="button" className="btn quiet sm tour-skip" onClick={onEnd}>Skip</button>}
          {i > 0 && <button type="button" className="btn ghost sm tour-back" onClick={back}>Back</button>}
          <button type="button" className="btn sm tour-next" onClick={next}>{last ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
