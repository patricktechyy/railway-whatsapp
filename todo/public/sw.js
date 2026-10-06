/* Gavin's Todolist service worker (served from /todo/sw.js, looking after the whole
   site, scope "/"). It shows push notifications (reminders, tasks people give you,
   nudges, announcements) in the phone's or computer's notification bar, even when the
   site is closed; tells any open page so it can play the chime; and opens the task
   when a notification is tapped. It doesn't touch page loads at all (no fetch handler). */

const BASE = new URL('./', self.location.href).pathname // "/todo/"
const ICON = BASE + 'icon-192.png'
const BADGE = BASE + 'badge-96.png'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { title: event.data && event.data.text() } }
  const title = d.title || "Gavin's Todolist"
  // reminders and tasks from people stay on screen until you deal with them (where the system allows it)
  const sticky = d.kind === 'reminder' || d.kind === 'assigned' || d.kind === 'nudge'
  // show it, and tell open pages (for the chime); one failing never stops the other
  event.waitUntil(Promise.allSettled([
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!d.tag, // a new reminder with the same tag still buzzes and makes a sound
      silent: false, // use the device's notification sound
      requireInteraction: sticky,
      icon: ICON,
      badge: BADGE,
      vibrate: [180, 80, 180],
      timestamp: Date.now(),
      data: { taskId: d.taskId || null },
    }),
    // any open Whats Up / Todolist page plays the chime (they make sure it rings once)
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pages) => {
      for (const c of pages) c.postMessage({ type: 'todo-notify', title, body: d.body || '', tag: d.tag || null, taskId: d.taskId || null })
    }),
  ]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const taskId = event.notification.data && event.notification.data.taskId
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const path = (c) => new URL(c.url).pathname
    const top = tabs.filter((c) => c.frameType !== 'nested')
    // the Todolist open in its own tab
    const own = top.find((c) => path(c).startsWith(BASE))
    if (own) {
      await own.focus()
      if (taskId) own.postMessage({ type: 'open-task', taskId })
      return
    }
    // …or Whats Up open: bring it forward, switch to its Todolist tab and open the task there
    const wa = top.find((c) => /^\/u\/[^/]+\//.test(path(c)))
    if (wa) {
      try { await wa.focus() } catch {}
      wa.postMessage({ type: 'open-todo', taskId: taskId || null })
      return
    }
    await self.clients.openWindow(taskId ? `${BASE}?task=${encodeURIComponent(taskId)}` : BASE)
  })())
})
