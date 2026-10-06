import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { toast } from './components/Toast'
import type { Group, GroupTask, TaskInput } from './types'

export type GroupTaskInput = TaskInput & { assignee?: string | null }

/**
 * The groups you're in, kept live: whenever someone in a group changes something,
 * the server says so (a "group" event) and we fetch the groups again.
 */
export function useGroups() {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const load = useCallback(() => api<Group[]>('/groups').then(setGroups).catch(() => {}), [])

  useEffect(() => {
    load()
    const onEv = (e: Event) => {
      if ((e as CustomEvent).detail?.type !== 'group') return
      clearTimeout(timer.current)
      timer.current = window.setTimeout(load, 150) // a burst of changes → one fetch
    }
    // the live connection can miss things while a phone sleeps: catch up when we're back
    const onShow = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('todo:event', onEv)
    document.addEventListener('visibilitychange', onShow)
    return () => { window.removeEventListener('todo:event', onEv); document.removeEventListener('visibilitychange', onShow); clearTimeout(timer.current) }
  }, [load])

  /** Change one group's tasks here straight away; the server's answer (or a reload) settles it. */
  const patchTasks = (gid: string, fn: (ts: GroupTask[]) => GroupTask[]) =>
    setGroups((gs) => gs && gs.map((g) => (g.id === gid ? { ...g, tasks: fn(g.tasks) } : g)))

  const run = async <T,>(p: Promise<T>): Promise<T | null> => {
    try { return await p } catch (e: any) { toast(e.message); load(); return null }
  }

  return {
    groups,
    reload: load,
    // making and changing groups is the admin's job (the admin needn't be in the group)
    create: async (body: { name: string; emoji: string; members: string[] }) => {
      const g = await run(api<Group>('/admin/groups', 'POST', body))
      if (g) load()
      return g
    },
    update: async (gid: string, body: { name?: string; emoji?: string; members?: string[] }) => {
      const g = await run(api<Group>(`/admin/groups/${gid}`, 'PATCH', body))
      if (g) load()
      return g
    },
    remove: async (gid: string) => {
      if (await run(api(`/admin/groups/${gid}`, 'DELETE'))) setGroups((gs) => gs && gs.filter((x) => x.id !== gid))
    },
    addTask: async (gid: string, body: GroupTaskInput) => {
      const t = await run(api<GroupTask>(`/groups/${gid}/tasks`, 'POST', body))
      if (t) patchTasks(gid, (ts) => [t, ...ts.filter((x) => x.id !== t.id)])
      return t
    },
    updateTask: async (gid: string, tid: string, body: GroupTaskInput) => {
      patchTasks(gid, (ts) => ts.map((x) => (x.id === tid ? { ...x, ...body } as GroupTask : x)))
      const t = await run(api<GroupTask>(`/groups/${gid}/tasks/${tid}`, 'PATCH', body))
      if (t) patchTasks(gid, (ts) => ts.map((x) => (x.id === tid ? t : x)))
    },
    deleteTask: async (gid: string, tid: string) => {
      patchTasks(gid, (ts) => ts.filter((x) => x.id !== tid))
      await run(api(`/groups/${gid}/tasks/${tid}`, 'DELETE'))
    },
    clearDone: async (gid: string) => {
      patchTasks(gid, (ts) => ts.filter((x) => !x.done))
      await run(api(`/groups/${gid}/clear-done`, 'POST', {}))
    },
  }
}
