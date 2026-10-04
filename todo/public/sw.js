/* Gavin's Todolist service worker: shows push notifications (reminders)
   even when the site is closed, and opens the task when one is tapped. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { title: event.data && event.data.text() } }
  const title = d.title || "Gavin's Todolist"
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: self.registration.scope + 'icon-192.png',
    badge: self.registration.scope + 'badge-96.png',
    vibrate: [120, 60, 120],
    data: { taskId: d.taskId || null },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const taskId = event.notification.data && event.notification.data.taskId
  event.waitUntil((async () => {
    const scope = self.registration.scope // …/todo/
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // the Todolist open in its own tab
    const own = tabs.find((c) => c.url.startsWith(scope) && c.frameType !== 'nested')
    if (own) {
      await own.focus()
      if (taskId) own.postMessage({ type: 'open-task', taskId })
      return
    }
    // …or inside Whats Up (its Todolist tab): bring Whats Up forward and open the task there
    const inside = tabs.find((c) => c.url.startsWith(scope) && c.frameType === 'nested')
    const host = tabs.find((c) => !c.url.startsWith(scope) && c.frameType !== 'nested' && /\/u\/[^/]+\//.test(new URL(c.url).pathname))
    if (inside && host) {
      try { await host.focus() } catch {}
      host.postMessage({ type: 'open-todo' })
      if (taskId) inside.postMessage({ type: 'open-task', taskId })
      return
    }
    await self.clients.openWindow(taskId ? `${scope}?task=${encodeURIComponent(taskId)}` : scope)
  })())
})
