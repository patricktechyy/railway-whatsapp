import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiRev, BASE, type Versioned } from './api'
import type { Board, Data, List, Task, TaskInput } from './types'
import { toast } from './components/Toast'

/**
 * The person's tasks and lists. Changes show up instantly (optimistic), are
 * sent to the server, and every other open device refreshes over a live
 * event stream.
 *
 * Every signed-in response carries the version (`rev`) of the data it made.
 * When a save comes back as exactly the next version, what's on screen already
 * matches the server, so there's nothing to download again. Anything else (a
 * change from another device, two saves crossing, the server doing more than
 * we did here, a failed save) reloads the truth from the server. A reload keeps
 * every task and list that didn't change as the very same object, so only the
 * rows that really changed are redrawn.
 */

/** The same status/done rules the server applies, so the screen updates instantly. */
function applyLocal(t: Task, patch: TaskInput): Task {
  const next = { ...t, ...patch, updatedAt: Date.now() }
  if ('status' in patch || 'done' in patch) {
    const status = patch.status ?? (patch.done ? 'done' : t.status === 'done' || t.done ? 'todo' : t.status || 'todo')
    next.status = status
    next.done = status === 'done'
    next.doneAt = next.done ? (t.done ? t.doneAt : Date.now()) : null
  }
  return next
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Keep the old object for everything that didn't change (and the old array if nothing did). */
function share<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const old = new Map(prev.map((x) => [x.id, x]))
  let changed = prev.length !== next.length
  const out = next.map((x, i) => {
    const o = old.get(x.id)
    const keep = o && same(o, x) ? o : x
    if (keep !== prev[i]) changed = true
    return keep
  })
  return changed ? out : prev
}
function reconcile(prev: Data | null, next: Data): Data {
  if (!prev) return next
  return {
    ...next,
    tasks: share(prev.tasks, next.tasks),
    lists: share(prev.lists, next.lists),
    dayNotes: same(prev.dayNotes, next.dayNotes) ? prev.dayNotes : next.dayNotes,
    board: same(prev.board, next.board) ? prev.board : next.board,
    profile: same(prev.profile, next.profile) ? prev.profile : next.profile,
  }
}

/**
 * A task added here first has a temporary id, then the server's. Rows are keyed
 * by the first id they had, so the row isn't thrown away and rebuilt (no flicker,
 * no replayed animation) when the real id arrives.
 */
const firstIds = new Map<string, string>()
export const rowKey = (id: string) => firstIds.get(id) ?? id

export function useData() {
  const [data, setData] = useState<Data | null>(null)
  const [online, setOnline] = useState(true)
  const dataRef = useRef<Data | null>(null)
  dataRef.current = data
  const pending = useRef(0) // saves on their way to the server
  const loadedRev = useRef(0) // the version what's on screen matches
  const latestRev = useRef(0) // the newest version the server has told us about
  const loading = useRef<'idle' | 'busy' | 'again'>('idle')

  const reload = useCallback(async () => {
    if (loading.current !== 'idle') { loading.current = 'again'; return }
    loading.current = 'busy'
    try {
      const { data: d } = await apiRev<Data>('/data')
      latestRev.current = Math.max(latestRev.current, d.rev)
      // a save started while this was loading: what's on screen is newer, so wait for it (catchUp reloads after)
      if (!pending.current || !dataRef.current) {
        loadedRev.current = d.rev
        setData((prev) => reconcile(prev, d))
      }
    } catch {}
    const again = (loading.current as string) === 'again'
    loading.current = 'idle'
    if (again) reload()
  }, [])

  /** Reload only when the server has something we haven't got, and our own saves have landed. */
  const catchUp = useCallback(() => {
    if (!pending.current && latestRev.current > loadedRev.current) reload()
  }, [reload])

  // live updates from other devices
  useEffect(() => {
    reload()
    let es: EventSource | null = null
    let timer: number | undefined
    const connect = () => {
      es = new EventSource(`${BASE}api/events`)
      es.onopen = () => setOnline(true)
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data)
        window.dispatchEvent(new CustomEvent('todo:event', { detail: ev }))
        if (ev.type === 'changed' && typeof ev.rev === 'number') {
          latestRev.current = Math.max(latestRev.current, ev.rev)
          catchUp()
        }
      }
      es.onerror = () => {
        setOnline(false)
        if (es?.readyState === EventSource.CLOSED) timer = window.setTimeout(connect, 5000)
      }
    }
    connect()
    const onVisible = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      es?.close()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reload, catchUp])

  /**
   * Apply `local` right away, then run `remote`. `extra(result)` says the server did
   * more than `local` showed (so reload); `apply` folds the server's answer in.
   */
  const mutate = useCallback(
    async <T,>(
      local: (d: Data) => Data,
      remote: () => Promise<Versioned<T>>,
      opts: { extra?: (result: T) => boolean; apply?: (d: Data, result: T) => Data } = {},
    ): Promise<T | undefined> => {
      setData((d) => (d ? local(d) : d))
      pending.current++
      try {
        const { data: result, rev } = await remote()
        if (rev === null) latestRev.current = Math.max(latestRev.current, loadedRev.current + 1) // older server: reload as before
        else {
          if (rev === loadedRev.current + 1 && !opts.extra?.(result)) loadedRev.current = rev
          latestRev.current = Math.max(latestRev.current, rev)
        }
        if (opts.apply) setData((d) => (d ? opts.apply!(d, result) : d))
        return result
      } catch (e: any) {
        toast(e.message || 'Could not save')
        latestRev.current = Math.max(latestRev.current, loadedRev.current + 1) // put the truth back
        return undefined
      } finally {
        pending.current--
        catchUp()
      }
    },
    [catchUp],
  )

  const boardTimer = useRef<number | undefined>(undefined)
  const tempId = () => `tmp-${Math.random().toString(36).slice(2)}`

  const actions = useMemo(() => {
    const a = {
      addTask: async (input: TaskInput & { title: string }) => {
        const id = tempId()
        const now = Date.now()
        const draft: Task = {
          id, notes: '', listId: null, done: false, status: 'todo', doneAt: null, due: null, time: null,
          remind: null, repeat: null, priority: 0, tags: [], subtasks: [], links: [], order: -Infinity, createdAt: now, updatedAt: now, ...input,
        }
        return mutate(
          (d) => ({ ...d, tasks: [...d.tasks, draft] }),
          () => apiRev<Task>('/tasks', 'POST', input),
          {
            apply: (d, saved) => {
              if (!saved) return d
              firstIds.set(saved.id, id)
              return { ...d, tasks: d.tasks.map((t) => (t.id === id ? saved : t)) }
            },
          },
        )
      },
      updateTask: (id: string, patch: TaskInput) => {
        const before = dataRef.current?.tasks.find((t) => t.id === id)
        return mutate(
          (d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? applyLocal(t, patch) : t)) }),
          () => apiRev<Task>(`/tasks/${id}`, 'PATCH', patch),
          // finishing (or un-finishing) a repeating task adds (or removes) the next copy on the server
          { extra: (saved) => !before || !saved || (saved.spawnedId ?? null) !== (before.spawnedId ?? null) || !!saved.repeat !== !!before.repeat },
        )
      },
      deleteTask: (id: string) =>
        mutate((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }), () => apiRev(`/tasks/${id}`, 'DELETE')),
      /** Restore a deleted task (for Undo). It gets a new id. */
      restoreTask: (t: Task) => {
        const { id: _id, order: _o, createdAt: _c, updatedAt: _u, doneAt: _d, ...input } = t
        return a.addTask(input)
      },
      reorderTasks: (ids: string[]) =>
        mutate(
          (d) => {
            const slots = ids.map((id) => d.tasks.find((t) => t.id === id)?.order ?? 0).sort((x, y) => x - y)
            const next = new Map(ids.map((id, i) => [id, slots[i]]))
            return { ...d, tasks: d.tasks.map((t) => (next.has(t.id) ? { ...t, order: next.get(t.id)! } : t)) }
          },
          () => apiRev('/tasks/reorder', 'POST', { ids }),
        ),
      clearCompleted: (listId?: string) =>
        mutate(
          (d) => ({ ...d, tasks: d.tasks.filter((t) => !t.done || (listId ? t.listId !== listId : false)) }),
          () => apiRev('/tasks/clear-completed', 'POST', { listId: listId || null }),
        ),
      setDayNote: (date: string, note: { label: string; notes: string; color: string }) =>
        mutate(
          (d) => ({ ...d, dayNotes: { ...(d.dayNotes || {}), [date]: note as any } }),
          () => apiRev(`/days/${date}`, 'PUT', note),
        ),
      deleteDayNote: (date: string) =>
        mutate(
          (d) => { const n = { ...(d.dayNotes || {}) }; delete n[date]; return { ...d, dayNotes: n } },
          () => apiRev(`/days/${date}`, 'DELETE'),
        ),
      addList: (input: Pick<List, 'name'> & Partial<List>) =>
        mutate(
          (d) => d,
          () => apiRev<List>('/lists', 'POST', input),
          { apply: (d, saved) => (saved ? { ...d, lists: [...d.lists, saved] } : d) },
        ),
      updateList: (id: string, patch: Partial<List>) =>
        mutate(
          (d) => ({ ...d, lists: d.lists.map((l) => (l.id === id ? { ...l, ...patch } : l)) }),
          () => apiRev<List>(`/lists/${id}`, 'PATCH', patch),
        ),
      /** Keep its tasks (they go to "No list") or delete them too. Resolves to what Undo needs. */
      deleteList: (id: string, deleteTasks = false) =>
        mutate(
          (d) => ({
            ...d,
            lists: d.lists.filter((l) => l.id !== id),
            tasks: deleteTasks ? d.tasks.filter((t) => t.listId !== id) : d.tasks.map((t) => (t.listId === id ? { ...t, listId: null } : t)),
          }),
          () => apiRev<DeletedList>(`/lists/${id}${deleteTasks ? '?tasks=delete' : ''}`, 'DELETE'),
        ),
      restoreList: (deleted: DeletedList) =>
        // brings back tasks too, with the server's ids: always reload
        mutate((d) => d, () => apiRev<List>('/lists/restore', 'POST', deleted), { extra: () => true }),
      /** Shows at once; saved after a short pause, so typing a block's name doesn't send every letter. */
      saveBoard: (board: Board) => {
        setData((d) => (d ? { ...d, board } : d))
        if (boardTimer.current === undefined) pending.current++ // hold live reloads until it's saved
        else clearTimeout(boardTimer.current)
        boardTimer.current = window.setTimeout(() => {
          boardTimer.current = undefined
          pending.current--
          mutate((d) => d, () => apiRev<Board>('/board', 'PUT', board))
        }, 500)
      },
      reorderLists: (ids: string[]) =>
        mutate(
          (d) => ({ ...d, lists: d.lists.map((l) => ({ ...l, order: ids.indexOf(l.id) < 0 ? l.order : ids.indexOf(l.id) })) }),
          () => apiRev('/lists/reorder', 'POST', { ids }),
        ),
    }
    return a
  }, [mutate])

  return { data, online, actions, reload }
}

export interface DeletedList { list: List; tasks: Task[]; moved: string[] }

export type Actions = ReturnType<typeof useData>['actions']
