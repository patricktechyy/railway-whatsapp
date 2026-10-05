import { api, BASE } from './api'

/**
 * Turning notifications on for this device: ask permission, subscribe with the
 * server's key, and send the subscription (plus this device's timezone, so
 * "9am" means 9am here) to the server, which then pushes reminders even when
 * the site is closed. The phone or computer shows them in its notification
 * bar / Notification Center, like any app's.
 *
 * Two things make this work everywhere, not just on Windows:
 *  • The service worker covers the whole site (scope "/"), not just /todo/. Then the
 *    Whats Up page itself (and Whats Up installed on an iPhone's Home Screen) owns the
 *    subscription, and hears reminders too (for the sound).
 *  • Inside Whats Up the Todolist is a frame. Safari doesn't let a frame ask for
 *    notification permission, so we ask (and subscribe) through the Whats Up page
 *    around us: it's the same site, so we're allowed to.
 */

export type PushSupport = 'ok' | 'insecure' | 'unsupported' | 'ios-needs-install'

/** The service worker file, and the part of the site it looks after (all of it). */
export const SW_URL = `${BASE}sw.js`
export const SW_SCOPE = '/'

/** The top window when it's ours (Whats Up around the Todolist), else this one. */
export const host: Window = (() => {
  try {
    if (window.top && window.top !== window && window.top.location.origin === location.origin) return window.top
  } catch {}
  return window
})()
const hostNav = () => host.navigator
const HostNotification = () => (host as any).Notification as typeof Notification | undefined

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isMac = () => /Mac/.test(navigator.platform) && !isIOS()
const isStandalone = () => {
  try { return host.matchMedia('(display-mode: standalone)').matches || (hostNav() as any).standalone === true } catch { return false }
}

export function pushSupport(): PushSupport {
  if (!host.isSecureContext) return 'insecure'
  if (isIOS() && !isStandalone()) return 'ios-needs-install'
  if (!('serviceWorker' in hostNav()) || !('PushManager' in host) || !HostNotification()) return 'unsupported'
  return 'ok'
}

/** Current permission ('default' | 'granted' | 'denied'), or null if there's no notification support at all. */
export const permission = (): NotificationPermission | null => HostNotification()?.permission ?? null

const b64ToBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return true
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/** Wait for a registration's worker to be running (subscribing needs an active one). */
async function active(reg: ServiceWorkerRegistration) {
  if (reg.active) return reg
  const w = reg.installing || reg.waiting
  if (w) {
    await new Promise<void>((done) => {
      const t = setTimeout(done, 10000)
      w.addEventListener('statechange', () => { if (w.state === 'activated') { clearTimeout(t); done() } })
    })
  }
  return reg
}

async function registration() {
  const sw = hostNav().serviceWorker
  const reg = (await sw.getRegistration(SW_SCOPE)) || (await sw.register(SW_URL, { scope: SW_SCOPE }))
  return active(reg)
}

/** The registration that holds this device's subscription (if any yet). */
async function currentRegistration() {
  try {
    const reg = await hostNav().serviceWorker?.getRegistration(SW_SCOPE)
    // (the old /todo/-only worker is gone after registerServiceWorker() runs; don't mistake it for ours)
    return reg && new URL(reg.scope).pathname === SW_SCOPE ? reg : undefined
  } catch {
    return undefined
  }
}

let pushedCache: boolean | null = null
const remember = (on: boolean) => {
  pushedCache = on
  try { on ? localStorage.setItem('todo-push', '1') : localStorage.removeItem('todo-push') } catch {}
}

/** Subscribe (or refresh the subscription) and tell the server. Needs permission already granted. */
async function subscribe() {
  const reg = await registration()
  const { key } = await api<{ key: string }>('/push/key')
  const want = b64ToBytes(key)
  let sub = await reg.pushManager.getSubscription()
  // a subscription made with an old server key won't work any more
  if (sub && !sameKey(sub.options.applicationServerKey, want)) { await sub.unsubscribe(); sub = null }
  try {
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want })
  } catch (e: any) {
    console.warn('Push subscribe failed:', e)
    throw new Error('Your browser couldn’t reach its notification service. Check you’re online (and not in a private window), then try again.')
  }
  await api('/push/subscribe', 'POST', { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  remember(true)
}

/**
 * Start the service worker. Also moves devices set up before it covered the whole
 * site (it used to look after /todo/ only) over to the new one, quietly: the
 * permission was already given, so there's no prompt.
 */
export async function registerServiceWorker() {
  const sw = hostNav().serviceWorker
  if (!sw || !host.isSecureContext) return
  try {
    let carry = false
    for (const r of await sw.getRegistrations()) {
      if (new URL(r.scope).pathname !== BASE) continue
      const old = await r.pushManager.getSubscription().catch(() => null)
      if (old) {
        carry = true
        api('/push/unsubscribe', 'POST', { endpoint: old.endpoint }).catch(() => {})
        await old.unsubscribe().catch(() => false)
      }
      await r.unregister().catch(() => false)
    }
    const reg = await sw.register(SW_URL, { scope: SW_SCOPE })
    reg.update().catch(() => {}) // pick up a new version of the worker promptly
    let wasOn = false
    try { wasOn = localStorage.getItem('todo-push') === '1' } catch {}
    if ((carry || wasOn) && permission() === 'granted') {
      // also repairs a device whose subscription the push service dropped
      await subscribe().catch((e) => console.warn('Couldn’t refresh notifications:', e))
    }
  } catch (e) {
    console.warn('Service worker not registered:', e)
  }
}

/** Is this very device subscribed? */
export async function pushEnabledHere(): Promise<boolean> {
  if (pushSupport() !== 'ok' || permission() !== 'granted') { pushedCache = false; return false }
  const reg = await currentRegistration()
  try {
    const on = !!(await reg?.pushManager.getSubscription())
    pushedCache = on
    return on
  } catch {
    return false
  }
}
/** Last known answer of pushEnabledHere(), without waiting (for the in-page reminder check). */
export const pushedHere = () => {
  if (pushedCache !== null) return pushedCache
  try { return localStorage.getItem('todo-push') === '1' && permission() === 'granted' } catch { return false }
}

export async function enablePush(): Promise<void> {
  const support = pushSupport()
  if (support !== 'ok') throw new Error(supportMessage(support))
  const N = HostNotification()!
  // asked through the top window: Safari ignores this from inside a frame
  const perm = await N.requestPermission()
  if (perm !== 'granted') throw new Error(perm === 'denied' ? blockedMessage() : 'Notifications weren’t allowed.')
  await subscribe()
}

export async function disablePush(): Promise<void> {
  const reg = await currentRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api('/push/unsubscribe', 'POST', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe()
  }
  remember(false)
}

/** Send a test notification to this very device (through the server and the push service, like a real reminder). */
export async function testPush() {
  const sub = await (await currentRegistration())?.pushManager.getSubscription()
  if (!sub) { remember(false); throw new Error('This device isn’t signed up for notifications any more. Turn them on again.') }
  try {
    return await api<{ sent: number; devices: number }>('/push/test', 'POST', { endpoint: sub.endpoint })
  } catch (e: any) {
    // the server lost this device (or the service dropped it): sign it up again, then retry once
    if (e.status === 409 && permission() === 'granted') {
      await subscribe()
      const fresh = await (await currentRegistration())?.pushManager.getSubscription()
      return api<{ sent: number; devices: number }>('/push/test', 'POST', { endpoint: fresh?.endpoint || sub.endpoint })
    }
    throw e
  }
}

/** Show a notification from this tab (used when push isn't set up on this device). */
export async function showLocalNotification(title: string, body: string, taskId?: string) {
  const N = HostNotification()
  if (!N || N.permission !== 'granted') return false
  const opts: NotificationOptions = { body, icon: `${BASE}icon-192.png`, badge: `${BASE}badge-96.png`, tag: taskId, silent: false, data: { taskId } }
  try {
    // phones only allow notifications through the service worker
    const reg = await currentRegistration()
    if (reg) {
      await reg.showNotification(title, opts)
      return true
    }
    new N(title, opts)
    return true
  } catch {
    return false
  }
}

export function supportMessage(s: PushSupport) {
  switch (s) {
    case 'insecure': return 'Notifications need a secure (https) address. Open the site from its Railway link, or http://localhost on this computer.'
    case 'ios-needs-install': return 'On iPhone/iPad, Apple only allows notifications for apps on your Home Screen: in Safari tap Share → Add to Home Screen, open Whats Up from your Home Screen, sign in, then turn notifications on here.'
    case 'unsupported': return 'This browser can’t show notifications.'
    default: return ''
  }
}

function blockedMessage() {
  if (isIOS()) return 'Notifications are blocked. Turn them on in the iPhone’s Settings → Notifications → Whats Up, then try again.'
  if (isMac()) return 'Notifications are blocked for this site. Allow them with the 🔒 / ⓘ next to the address (Safari: Settings → Websites → Notifications), then try again.'
  return 'Notifications are blocked. Allow them for this site in your browser settings (the 🔒 next to the address), then try again.'
}

/** Where to look when a test notification doesn't show up, for this kind of device. */
export function deviceTip(): string {
  if (isIOS()) return 'Nothing showed? On the iPhone: Settings → Notifications → Whats Up → Allow Notifications, with Sounds on. Focus modes can hide them too.'
  if (isMac()) return 'Nothing showed? On a Mac, also allow your browser itself: System Settings → Notifications → (Chrome / Safari / Edge…) → Allow notifications, style Banners or Alerts, sound on. Focus / Do Not Disturb hides them.'
  if (/Android/.test(navigator.userAgent)) return 'Nothing showed? Check Android Settings → Apps → your browser → Notifications are allowed, and battery saver isn’t blocking it.'
  if (/Win/.test(navigator.platform)) return 'Nothing showed? Check Windows Settings → System → Notifications → your browser is on, and Do not disturb is off.'
  return ''
}
