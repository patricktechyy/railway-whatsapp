import { host } from './push'

/**
 * The little "ding-dong" when a Todolist notification arrives: a reminder, a task
 * someone gave you, a nudge or an announcement.
 *
 * It's made with Web Audio (no sound file to load), and played by the top window:
 * inside Whats Up that's the Whats Up page (chat.html has the same chime as
 * `window.todoChime`), so it plays even while you're looking at your chats. One
 * notification never rings twice: tabs, the Whats Up page and the Todolist frame
 * all check the same "last rang at" time.
 *
 * Browsers only allow sound after you've touched the page once, so the first
 * click or key press anywhere "unlocks" it.
 *
 * The system notification (notification bar / Notification Center) also makes the
 * phone's or computer's own notification sound; this one is for while the site is open.
 */

export interface Chime { play(): boolean; unlock(): void }
const STAMP = 'todo-chime-at'

/** Settings → Notifications → "Play a sound" (on unless switched off, per device). */
export function soundOn() {
  try { return JSON.parse(localStorage.getItem('todo-prefs') || '{}').sound !== false } catch { return true }
}

function makeChime(w: Window): Chime {
  let ctx: AudioContext | null = null
  const AC = (w as any).AudioContext || (w as any).webkitAudioContext
  const context = () => (ctx ||= AC ? new AC() : null)
  const note = (c: AudioContext, freq: number, at: number, len: number, peak: number) => {
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(freq, at)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(peak, at + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, at + len)
    o.connect(g).connect(c.destination)
    o.start(at)
    o.stop(at + len + 0.05)
  }
  return {
    unlock() {
      const c = context()
      if (c && c.state === 'suspended') c.resume().catch(() => {})
    },
    play() {
      if (!soundOn()) return false
      // the same notification, heard by several pages/tabs: ring once
      const now = Date.now()
      try {
        if (now - Number(localStorage.getItem(STAMP) || 0) < 2500) return false
        localStorage.setItem(STAMP, String(now))
      } catch {}
      const c = context()
      if (!c) return false
      const go = () => {
        const t = c.currentTime + 0.02
        note(c, 880, t, 0.55, 0.22) // A5
        note(c, 1318.5, t + 0.14, 0.75, 0.18) // E6
      }
      if (c.state === 'suspended') c.resume().then(go).catch(() => {})
      else go()
      return true
    },
  }
}

/** The chime of the top window (Whats Up's, when we're inside it). */
export function chime(): Chime {
  const h = host as any
  return (h.todoChime ||= makeChime(host))
}

/** Unlock sound on the first touch of this page (and of Whats Up around it). */
export function setupSound() {
  const unlock = () => chime().unlock()
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true })
  // a push arriving while the site is open: the service worker tells every open page
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'todo-notify') chime().play()
  })
  try { navigator.serviceWorker?.startMessages() } catch {}
}
