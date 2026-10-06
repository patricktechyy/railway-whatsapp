import { useState, type FormEvent, type MouseEvent } from 'react'
import { cleanUrl, hostOf } from '../quickadd'
import type { TaskLink } from '../types'

export const LinkIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1" /><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1" /></svg>
)

/** A link that always opens in a new tab, without giving that page access to this one. */
export function ExtLink({ link, className = 'link-chip' }: { link: TaskLink; className?: string }) {
  return (
    <a className={className} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} onClick={(e: MouseEvent) => e.stopPropagation()}>
      <LinkIcon />
      <span>{link.title || hostOf(link.url)}</span>
    </a>
  )
}

/** Add a link: address (required, http/https only) and an optional name. */
export function AddLinkForm({ onAdd, autoFocus = true }: { onAdd: (l: TaskLink) => void; autoFocus?: boolean }) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [err, setErr] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const clean = cleanUrl(url)
    if (!clean) return setErr('Enter a web address, like https://example.com')
    onAdd({ url: clean, title: title.trim().slice(0, 80) })
    setUrl('')
    setTitle('')
    setErr('')
  }
  return (
    <form className="link-form" onSubmit={submit} noValidate>
      <input className="input sm" value={url} onChange={(e) => { setUrl(e.target.value); setErr('') }} placeholder="https://…" inputMode="url" aria-label="Link address" autoFocus={autoFocus} aria-invalid={!!err} />
      <input className="input sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name (optional)" maxLength={80} aria-label="Link name" />
      <button className="btn sm" disabled={!url.trim()}>Add link</button>
      {err && <p className="help bad" role="alert">{err}</p>}
    </form>
  )
}
