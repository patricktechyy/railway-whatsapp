export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The Todolist lives at /todo/ inside Whats Up: its page, its API and its service worker. */
export const BASE = '/todo/'

/** Inside Whats Up's own page (the Todolist tab, or the admin's Todolist tab)? */
export const framed = (() => { try { return window.parent !== window } catch { return true } })()
/** ?embed=admin: only the admin page (Whats Up's admin → Todolist tab). */
export const embedAdmin = new URLSearchParams(location.search).get('embed') === 'admin'

/** Tell the Whats Up page around us something (open chats, the badge changed, …). */
export function toWhatsUp(msg: Record<string, unknown>) {
  if (framed) try { window.parent.postMessage({ source: 'todolist', ...msg }, location.origin) } catch {}
}

/** Signed out of Whats Up: go to its sign-in, and come back here afterwards. */
export function goSignIn() {
  const next = encodeURIComponent(location.pathname + location.hash)
  const target = `/?next=${next}`
  try { if (framed) { window.top!.location.href = '/'; return } } catch {}
  location.href = target
}

/** A response plus the version of your data the server had right after it (from `x-rev`). */
export interface Versioned<T> { data: T; rev: number | null }

export async function apiRev<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<Versioned<T>> {
  const r = await fetch(`${BASE}api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  let d: any = null
  try { d = await r.json() } catch {}
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event('todo:signed-out'))
    throw new ApiError(r.status, d?.error || `Request failed (${r.status})`)
  }
  const rev = Number(r.headers.get('x-rev'))
  return { data: d as T, rev: Number.isFinite(rev) && rev > 0 ? rev : null }
}

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return (await apiRev<T>(path, method, body)).data
}
