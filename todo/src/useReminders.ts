import { useEffect, useRef } from 'react'
import { formatDue, remindAt } from './dates'
import type { Task } from './types'
import { toast } from './components/Toast'
import { showLocalNotification } from './push'

const KEY = 'todo-reminded'

/**
 * Reminders while the site is open: a message on the page, plus a system
 * notification if this device isn't already getting them from the server. Each reminder fires once per
 * device; changing the due date or reminder makes it eligible again.
 */
export function useReminders(tasks: Task[] | undefined, onOpen: (t: Task) => void) {
  const latest = useRef({ tasks, onOpen })
  const checkRef = useRef<() => void>(() => {})
  latest.current = { tasks, onOpen }

  useEffect(() => {
    const check = () => {
      const list = latest.current.tasks
      if (!list) return
      let fired: Record<string, number> = {}
      try { fired = JSON.parse(localStorage.getItem(KEY) || '{}') } catch {}
      const now = Date.now()
      let changed = false
      for (const t of list) {
        // (a task still being saved has a temporary id: wait for the real one, or it would ring twice)
        if (t.done || t.id.startsWith('tmp-')) continue
        const at = remindAt(t)
        if (at === null || at > now) continue
        const sig = `${t.id}|${t.due}|${t.time}|${t.remind}`
        if (fired[sig]) continue
        fired[sig] = now
        changed = true
        // don't ring for reminders that were missed by more than a day
        if (now - at > 864e5) continue
        const body = t.due ? `Due ${formatDue(t)}` : ''
        toast(`🔔 ${t.title}`, { label: 'Open', run: () => latest.current.onOpen(t) })
        // if this device gets server push, the server sends the system notification
        let pushed = false
        try { pushed = localStorage.getItem('todo-push') === '1' } catch {}
        if (!pushed) showLocalNotification(`🔔 ${t.title}`, body, t.id)
      }
      if (changed) {
        // forget reminders older than 30 days so this never grows forever
        for (const [k, v] of Object.entries(fired)) if (now - v > 30 * 864e5) delete fired[k]
        try { localStorage.setItem(KEY, JSON.stringify(fired)) } catch {}
      }
    }
    checkRef.current = check
    check()
    const i = window.setInterval(check, 20000)
    return () => clearInterval(i)
  }, [])

  // also check as soon as tasks arrive (and whenever they change), not just every 20s
  const loaded = !!tasks
  useEffect(() => { if (loaded) checkRef.current() }, [loaded, tasks])
}
