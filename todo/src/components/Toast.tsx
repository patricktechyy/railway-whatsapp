import { useEffect, useState } from 'react'

type ToastMsg = { text: string; action?: { label: string; run: () => void } }
let push: ((m: ToastMsg) => void) | null = null

/** Show a short message at the bottom of the screen, optionally with an action like Undo. */
export function toast(text: string, action?: ToastMsg['action']) {
  push?.({ text, action })
}

export function Toaster() {
  const [msg, setMsg] = useState<ToastMsg | null>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    let t: number | undefined
    push = (m) => {
      setMsg(m)
      setOn(true)
      clearTimeout(t)
      t = window.setTimeout(() => setOn(false), m.action ? 5000 : 2600)
    }
    return () => { push = null; clearTimeout(t) }
  }, [])
  return (
    <div id="toast" className={on ? 'on' : ''} role="status" aria-live="polite">
      {msg?.text}
      {msg?.action && (
        <button className="toast-action" onClick={() => { msg.action!.run(); setOn(false) }}>
          {msg.action.label}
        </button>
      )}
    </div>
  )
}
