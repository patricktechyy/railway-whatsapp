import { api, BASE } from './api'

/**
 * Turning notifications on for this device: ask permission, subscribe with the
 * server's key, and send the subscription (plus this device's timezone, so
 * "9am" means 9am here) to the server, which then pushes reminders even when
 * the site is closed.
 */

export type PushSupport = 'ok' | 'insecure' | 'unsupported' | 'ios-needs-install'

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure'
  if (isIOS() && !isStandalone()) return 'ios-needs-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return 'ok'
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch((e) => console.warn('Service worker not registered:', e))
}

const b64ToBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

async function registration() {
  const reg = (await navigator.serviceWorker.getRegistration(BASE)) || (await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }))
  return navigator.serviceWorker.ready.then(() => reg)
}

/** Is this very device subscribed? */
export async function pushEnabledHere(): Promise<boolean> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return false
  try {
    const reg = await navigator.serviceWorker.getRegistration(BASE)
    return !!(await reg?.pushManager.getSubscription())
  } catch {
    return false
  }
}

export async function enablePush(): Promise<void> {
  const support = pushSupport()
  if (support !== 'ok') throw new Error(supportMessage(support))
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Allow them for this site in your browser settings.' : 'Notifications weren’t allowed.')
  const reg = await registration()
  const { key } = await api<{ key: string }>('/push/key')
  let sub = await reg.pushManager.getSubscription()
  // a subscription made with an old server key won't work any more
  if (sub && sub.options.applicationServerKey) {
    const old = new Uint8Array(sub.options.applicationServerKey)
    const want = b64ToBytes(key)
    if (old.length !== want.length || old.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null }
  }
  try {
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) })
  } catch (e: any) {
    console.warn('Push subscribe failed:', e)
    throw new Error('Your browser couldn’t reach its notification service. Check you’re online (and not in a private window), then try again.')
  }
  await api('/push/subscribe', 'POST', { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  try { localStorage.setItem('todo-push', '1') } catch {}
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration(BASE)
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api('/push/unsubscribe', 'POST', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe()
  }
  try { localStorage.removeItem('todo-push') } catch {}
}

export const testPush = () => api<{ sent: number }>('/push/test', 'POST', {})

/** Show a notification from this tab (used when push isn't set up on this device). */
export async function showLocalNotification(title: string, body: string, taskId?: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false
  try {
    // Android Chrome only allows notifications through the service worker
    const reg = await navigator.serviceWorker?.getRegistration(BASE)
    if (reg) {
      await reg.showNotification(title, { body, icon: `${BASE}icon-192.png`, badge: `${BASE}badge-96.png`, tag: taskId, data: { taskId } })
      return true
    }
    new Notification(title, { body, icon: `${BASE}icon-192.png`, tag: taskId })
    return true
  } catch {
    return false
  }
}

export function supportMessage(s: PushSupport) {
  switch (s) {
    case 'insecure': return 'Notifications need a secure (https) address. Open the site from its Railway link, or http://localhost on this computer.'
    case 'ios-needs-install': return 'On iPhone/iPad, first tap Share → Add to Home Screen, then open the Todolist from your Home Screen and turn notifications on there.'
    case 'unsupported': return 'This browser can’t show notifications.'
    default: return ''
  }
}
