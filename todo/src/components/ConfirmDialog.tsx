import { useEffect, useRef, type ReactNode } from 'react'

/** A small "are you sure?" window. Enter confirms, Esc or the backdrop cancels. */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, danger, secondary }: {
  title: string
  children?: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean // the main button is destructive
  secondary?: { label: string; onClick: () => void; danger?: boolean } // a second choice, e.g. "Delete the tasks too"
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    btn.current?.focus()
  }, [])
  return (
    <dialog ref={ref} className="dialog confirm" onCancel={(e) => { e.preventDefault(); onCancel() }} onClick={(e) => { if (e.target === ref.current) onCancel() }} aria-label={title}>
      <div className="dialog-inner">
        <h2>{title}</h2>
        {children && <div className="confirm-body">{children}</div>}
        <div className={`dialog-actions${secondary ? ' confirm-choice-actions' : ''}`}>
          <div className="confirm-choice-row">
            <button className="btn ghost" onClick={onCancel}>Cancel</button>
            {secondary && <button className={`btn ${secondary.danger ? 'danger solid' : 'ghost'}`} onClick={secondary.onClick}>{secondary.label}</button>}
          </div>
          <button className={`btn${danger ? ' danger solid' : ''} confirm-primary`} ref={btn} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  )
}
