import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

interface Chat { jid: string; name: string; phone: string; group: boolean }

/** Pick one of your WhatsApp chats to send a task to. */
export function ChatPicker({ taskTitle, onPick, onClose, onSent }: { taskTitle: string; onPick: (jid: string) => Promise<unknown>; onClose: () => void; onSent: (name: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [q, setQ] = useState('')
  const [chats, setChats] = useState<Chat[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal() }, [])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api<{ chats: Chat[] }>(`/wa/chats?q=${encodeURIComponent(q)}`)
        .then((d) => { if (live) { setChats(d.chats); setErr('') } })
        .catch((e) => { if (live) { setErr(e.message); setChats([]) } })
    }, q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [q])

  return (
    <dialog ref={ref} className="dialog chat-picker" onCancel={(e) => { e.preventDefault(); onClose() }} onClick={(e) => { if (e.target === ref.current) onClose() }} aria-label="Send on WhatsApp">
      <div className="dialog-inner">
        <h2>Send on WhatsApp</h2>
        <p className="help">“{taskTitle}” will be sent from your WhatsApp to the chat you pick.</p>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats or type a number" autoFocus aria-label="Search chats" />
        {err && <p className="error" role="alert">{err}</p>}
        <ul className="chat-list">
          {chats === null && <li className="muted">Loading your chats…</li>}
          {chats?.length === 0 && !err && <li className="muted">No chats match.</li>}
          {chats?.map((c) => (
            <li key={c.jid}>
              <button disabled={!!busy} onClick={async () => { setBusy(c.jid); try { await onPick(c.jid); onSent(c.name) } catch (e: any) { setErr(e.message); setBusy(null) } }}>
                <span className="chat-avatar" aria-hidden="true">{c.group ? '👥' : (c.name || '?').trim()[0]?.toUpperCase()}</span>
                <span className="chat-name">{c.name}{c.phone && !c.group && <small>{c.phone}</small>}</span>
                <span className="chat-send">{busy === c.jid ? 'Sending…' : 'Send'}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="dialog-actions"><span className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </dialog>
  )
}
