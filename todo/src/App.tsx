import { useListColorStyles } from './listColor'
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { useEvent } from './useEvent'
import { SearchBox } from './components/SearchBox'
import { api, BASE, embedAdmin, framed, goSignIn, setHome, toWhatsUp } from './api'
import { addDays, daysBetween, formatDay, fromKey, MONTHS, todayKey, toKey, WEEKDAYS } from './dates'
import { usePrefs } from './prefs'
import type { Appearance, List, Me, Task, TaskInput, View } from './types'
import { applyAppearance } from './appearance'
import { useHolidays } from './useHolidays'
import { DayNote } from './components/DayNote'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ListMenu } from './components/ListMenu'
import { Tour } from './components/Tour'
import { tourSteps } from './tour'
import { BoardView, DEFAULT_WIDGETS } from './views/BoardView'
import type { DeletedList } from './useData'
import { useData } from './useData'
import { nextOccurrence } from './repeat'
import { nextStatus, statusOf, type Status as TaskStatus } from './status'
import { StatusBar } from './components/StatusBar'
import { enablePush, permission, pushEnabledHere, pushedHere, pushSupport, supportMessage } from './push'
import { chime } from './sound'
import { Fire } from './components/Fire'
import { ChatPicker } from './components/ChatPicker'
import { waStyle } from './components/WaPicker'
import { AdminView } from './views/AdminView'
import { GroupDialog, GroupView } from './views/GroupView'
import { useGroups } from './useGroups'
import type { Group as SharedGroup } from './types'
import { streakDays } from './stats'
import { useReminders } from './useReminders'
import { ResizeHandle, Sidebar, SidebarIcon, type Counts } from './components/Sidebar'
import { InlineEditor } from './components/InlineEditor'
import { Mark, WhatsUpLogo } from './components/Login'
import { TaskList, type Group } from './components/TaskList'
import { TaskEditor } from './components/TaskEditor'
import { NewTaskForm } from './components/NewTaskForm'
import { ListDialog, SettingsDialog } from './components/Dialogs'
import { Toaster, toast } from './components/Toast'
import { celebrate, rain } from './components/confetti'
import { CalendarView } from './views/CalendarView'
import { StatsView } from './views/StatsView'

// ------------------------------------------------------------------ routing
function parseHash(): View {
  const [, kind, arg] = location.hash.split('/')
  switch (kind) {
    case 'upcoming': case 'all': case 'completed': case 'calendar': case 'stats': case 'inbox': case 'today': case 'admin': case 'board':
      return { kind }
    case 'list': return arg ? { kind: 'list', id: arg } : { kind: 'today' }
    case 'group': return arg ? { kind: 'group', id: arg } : { kind: 'today' }
    case 'tag': return arg ? { kind: 'tag', tag: decodeURIComponent(arg) } : { kind: 'today' }
    default: return { kind: 'today' }
  }
}
const toHash = (v: View) => (v.kind === 'list' ? `#/list/${v.id}` : v.kind === 'group' ? `#/group/${v.id}` : v.kind === 'tag' ? `#/tag/${encodeURIComponent(v.tag)}` : `#/${v.kind}`)

type Status = 'active' | 'all' | 'done'
type Sort = 'manual' | 'due' | 'priority' | 'newest'

const byOrder = (a: Task, b: Task) => a.order - b.order
const byDue = (a: Task, b: Task) =>
  (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority || byOrder(a, b)
const SORTS: Record<Sort, (a: Task, b: Task) => number> = {
  manual: byOrder,
  due: byDue,
  priority: (a, b) => b.priority - a.priority || byDue(a, b),
  newest: (a, b) => b.createdAt - a.createdAt,
}

// --------------------------------------------------------------------- app
export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)

  // signed in with Whats Up: the same cookie opens this. Not signed in → Whats Up's sign-in, then back here.
  useEffect(() => {
    api<Me>('/me').then(setMe).catch(() => setMe(null))
    const out = () => setMe(null)
    window.addEventListener('todo:signed-out', out)
    return () => window.removeEventListener('todo:signed-out', out)
  }, [])
  useEffect(() => { if (me === null) goSignIn() }, [me])

  if (!me) return <div className="boot" aria-busy="true" />
  return (
    <>
      {embedAdmin ? <AdminOnly me={me} /> : <Shell me={me} setMe={setMe} />}
      <Toaster />
    </>
  )
}

/** Whats Up's admin page → Todolist tab: just the Todolist admin, live. */
function AdminOnly({ me }: { me: Me }) {
  useEffect(() => { applyAppearance(me.appearance) }, [me.appearance])
  useEffect(() => {
    const es = new EventSource(`${BASE}api/events`)
    es.onmessage = (e) => { try { window.dispatchEvent(new CustomEvent('todo:event', { detail: JSON.parse(e.data) })) } catch {} }
    return () => es.close()
  }, [])
  if (!me.admin) return <div className="empty">Only admins can see this page.</div>
  return (
    <main className="admin-embed">
      <AdminView me={me.username} />
    </main>
  )
}

function Shell({ me, setMe }: { me: Me; setMe: (m: Me | null) => void }) {
  const { data, online, actions } = useData()
  const groupsApi = useGroups()
  const [groupDialog, setGroupDialog] = useState<{ group?: SharedGroup } | null>(null)
  const [prefs, setPrefs] = usePrefs()
  const [view, setView] = useState<View>(parseHash)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search) // typing stays smooth; the list catches up a beat later
  const [status, setStatus] = useState<Status>('all')
  const [sort, setSort] = useState<Sort>('manual')
  const [day, setDay] = useState<string | null>(null) // calendar: the open day panel
  const [expandedId, setExpandedId] = useState<string | null>(null) // task being edited in the list
  const [peek, setPeek] = useState(false) // collapsed sidebar, hovered open
  const peekTimer = useRef<number | undefined>(undefined)
  const [menu, setMenu] = useState(false)
  const [listDialog, setListDialog] = useState<{ list?: List } | null>(null)
  const [settings, setSettings] = useState(false)
  const [, tick] = useState(0)
  const [deleting, setDeleting] = useState<List | null>(null) // list being deleted: keep or delete its tasks?
  const [confirmRepeat, setConfirmRepeat] = useState<{ task: Task; x?: number; y?: number } | null>(null) // confirm completion of repeating task
  const [tour, setTour] = useState(!me.tourDone) // first visit: show the tutorial
  const endTour = () => {
    setTour(false)
    setMenu(false)
    if (!me.tourDone) api<Me>('/profile', 'PATCH', { tourDone: true }).then(setMe).catch(() => {})
  }
  const [reminderSetup, setReminderSetup] = useState(false)
  const [reminderPushOn, setReminderPushOn] = useState(true)
  const [reminderWaOn, setReminderWaOn] = useState(me.waReminders !== false)
  useEffect(() => {
    if (tour) return
    let seen = false
    try { seen = localStorage.getItem(`todo-reminder-setup:${me.username}`) === '1' } catch {}
    if (seen) return
    let alive = true
    pushEnabledHere().then((_on) => { if (alive) setReminderSetup(true) }).catch(() => { if (alive) setReminderSetup(true) })
    setReminderWaOn(me.waReminders !== false)
    return () => { alive = false }
  }, [me.username, me.waReminders, tour])
  const finishReminderSetup = async () => {
    try { localStorage.setItem(`todo-reminder-setup:${me.username}`, '1') } catch {}
    let pushError = ''
    if (reminderPushOn && pushSupport() === 'ok') {
      try { await enablePush() } catch (e: any) { pushError = e.message || 'Couldn’t turn on notifications.' }
    }
    try {
      if (me.waReminders !== reminderWaOn) setMe(await api<Me>('/profile', 'PATCH', { waReminders: reminderWaOn }))
    } catch (e: any) {
      pushError = pushError ? `${pushError} WhatsApp: ${e.message}` : `WhatsApp: ${e.message}`
    }
    setReminderSetup(false)
    if (pushError) toast(`Not everything got turned on. ${pushError}`)
    else toast('Reminders saved')
  }

  waStyle.bot = me.whatsapp.botNumber // how Buddy's replies are worded in the pickers
  setHome(me.home)
  // colours follow the account, so every device looks the same
  useEffect(() => { applyAppearance(me.appearance) }, [me.appearance])
  const saveAppearance = useRef<number | undefined>(undefined)
  const year = new Date().getFullYear()
  const holidays = useHolidays(me.holidayCountry, year - 1, year + 1)
  const holidayName = (k: string) => holidays.get(k)?.join(' · ')
  const settingsOpen = useRef(false)
  useEffect(() => {
    // changed on another device (skipped while Settings is open here, so a live preview isn't undone)
    const onEv = (e: Event) => {
      if ((e as CustomEvent).detail?.type === 'profile' && !settingsOpen.current) api<Me>('/me').then(setMe).catch(() => {})
    }
    window.addEventListener('todo:event', onEv)
    return () => window.removeEventListener('todo:event', onEv)
  }, [])

  // routing
  useEffect(() => {
    const on = () => { setView(parseHash()); setMenu(false) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const navigate = useCallback((v: View) => {
    // inside Whats Up, the tab's history is shared with it: switch pages without adding Back steps
    if (framed) { history.replaceState(history.state, '', toHash(v)); window.dispatchEvent(new HashChangeEvent('hashchange')) }
    else location.hash = toHash(v)
    setSearch('')
  }, [])

  // a personal task's details don't belong on a group's page
  useEffect(() => { if (view.kind === 'group') setSelectedId(null) }, [view])

  // re-render at midnight-ish so "Today" and overdue stay right
  useEffect(() => {
    const i = window.setInterval(() => tick((n) => n + 1), 60000)
    return () => clearInterval(i)
  }, [])

  const tasks = data?.tasks || []
  const lists = useMemo(() => [...(data?.lists || [])].sort((a, b) => a.order - b.order), [data?.lists])
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists])
  useListColorStyles(lists) // lists with your own #rrggbb colour
  const selected = tasks.find((t) => t.id === selectedId) || null
  // ⓘ / reminders / calendar chips open the full details panel
  const open = useCallback((t: Task) => { setExpandedId(null); setSelectedId(t.id) }, [])
  // clicking a row edits it in place
  const expand = useCallback((t: Task) => setExpandedId((id) => (id === t.id ? null : t.id)), [])
  const collapse = useCallback(() => setExpandedId(null), [])
  const peekSidebar = useCallback((on: boolean) => {
    clearTimeout(peekTimer.current)
    peekTimer.current = window.setTimeout(() => setPeek(on), on ? 150 : 300)
  }, [])
  // Hiding/showing the sidebar: the page jumps to its new place in one go, then glides there
  // (a transform, so nothing is re-measured while it moves).
  const mainRef = useRef<HTMLElement>(null)
  const flipFrom = useRef<number | null>(null)
  const toggleSidebar = useEvent(() => {
    flipFrom.current = mainRef.current?.querySelector('.page')?.getBoundingClientRect().left ?? null
    setPeek(false)
    setPrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })
  })
  useLayoutEffect(() => {
    const page = mainRef.current?.querySelector<HTMLElement>('.page')
    const from = flipFrom.current
    flipFrom.current = null
    if (!page || from === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dx = from - page.getBoundingClientRect().left
    if (Math.abs(dx) < 1) return
    page.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' })
  }, [prefs.sidebarCollapsed])
  useReminders(data?.tasks, open)

  // the admin gave you a task, or nudged you about one: say so, with a way straight to it
  useEffect(() => {
    const onEv = (e: Event) => {
      const ev = (e as CustomEvent).detail
      // (with notifications on, the push for it rings already)
      if ((ev?.type === 'assigned' || (ev?.type === 'nudge' && ev.taskId)) && !pushedHere()) chime().play()
      if (ev?.type === 'assigned') toast(`📌 ${ev.by} gave you a task: ${ev.title}`, { label: 'Open', run: () => setSelectedId(ev.taskId) })
      else if (ev?.type === 'nudge' && ev.taskId) toast(`👋 ${ev.by} reminds you: ${ev.title}`, { label: 'Open', run: () => setSelectedId(ev.taskId) })
    }
    window.addEventListener('todo:event', onEv)
    return () => window.removeEventListener('todo:event', onEv)
  }, [])

  // a tapped notification opens its task: from the service worker (tab already open)…
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'open-task') setSelectedId(e.data.taskId) }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [])
  // …or from Whats Up around us (a tapped notification while the Todolist tab is open there)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.origin === location.origin && e.source === window.parent && e.data?.type === 'open-task' && e.data.taskId) setSelectedId(e.data.taskId) }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  // …or from the address (?task=…) when it opened a new tab
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('task')
    if (!id) return
    setSelectedId(id)
    history.replaceState(null, '', location.pathname + location.hash)
  }, [])

  // offer notifications once there's a reminder and this device isn't set up yet
  const [pushOn, setPushOn] = useState<boolean | null>(null)
  const [nudgeHidden, setNudgeHidden] = useState(() => { try { return localStorage.getItem('todo-push-nudge') === 'no' } catch { return false } })
  useEffect(() => { pushEnabledHere().then(setPushOn) }, [settings])
  settingsOpen.current = settings

  // tell the server this device's timezone (for reminders and WhatsApp), and show sign-in-link problems
  useEffect(() => {
    // (the answer can bring a first guess of the holiday country from the timezone)
    api<Me>('/profile', 'PATCH', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).then(setMe).catch(() => {})
    const err = new URLSearchParams(location.search).get('sso')
    if (err) { toast(err); history.replaceState(null, '', location.pathname + location.hash) }
  }, [])

  // announcements from the admin: a banner until dismissed on this device
  type Announcement = { id: string; title: string; body: string }
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [hiddenAnn, setHiddenAnn] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('todo-ann-hidden') || '[]') } catch { return [] } })
  useEffect(() => {
    const load = () => api<Announcement[]>('/announcements').then(setAnnouncements).catch(() => {})
    load()
    const onEv = (e: Event) => {
      if ((e as CustomEvent).detail?.type !== 'announcement') return
      load()
      if (!pushedHere()) chime().play()
    }
    window.addEventListener('todo:event', onEv)
    return () => window.removeEventListener('todo:event', onEv)
  }, [])
  const hideAnn = (id: string) => {
    const next = [...hiddenAnn, id].slice(-50)
    setHiddenAnn(next)
    try { localStorage.setItem('todo-ann-hidden', JSON.stringify(next)) } catch {}
  }
  const [sharing, setSharing] = useState<Task | null>(null)
  const hasReminders = !!data?.tasks.some((t) => !t.done && t.remind !== null && t.due)
  const showNudge = hasReminders && pushOn === false && !nudgeHidden && pushSupport() === 'ok' && permission() !== 'denied'

  // an unknown list in the URL (deleted on another device) falls back to Today
  useEffect(() => {
    if (data && view.kind === 'list' && !listById.has(view.id)) navigate({ kind: 'today' })
  }, [data, view, listById])

  // keyboard: N = new task, / = search, [ = sidebar, Esc = close the calendar's day panel
  const keyState = useRef({ selectedId, expandedId, toggleSidebar })
  keyState.current = { selectedId, expandedId, toggleSidebar }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === 'Escape' && !keyState.current.selectedId && !keyState.current.expandedId && !document.querySelector('[data-popover], dialog[open]')) {
        setDay(null)
        return
      }
      if (el.closest('input, textarea, select, [contenteditable], dialog') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '[') { e.preventDefault(); keyState.current.toggleSidebar(); return }
      if (e.key === 'n' || e.key === 'N') {
        // opens the New task form (or jumps into it if it's already open)
        const q = document.querySelector<HTMLElement>('[data-quick-add]')
        if (q) { e.preventDefault(); if (q.tagName === 'BUTTON') q.click(); else q.focus() }
      } else if (e.key === '/') {
        const s = document.querySelector<HTMLInputElement>('[data-search]')
        if (s) { e.preventDefault(); s.focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // inside Whats Up: its privacy keys keep working here (C / P = panic, L = lock, T = back to chats),
  // and using the todolist counts as being active (so its auto-lock doesn't kick in mid-task)
  useEffect(() => {
    if (!framed) return
    let last = 0
    const active = () => { if (Date.now() - last > 10000) { last = Date.now(); toWhatsUp({ type: 'active' }) } }
    const onKey = (e: KeyboardEvent) => {
      active()
      const el = e.target as HTMLElement
      if (el.closest?.('input, textarea, select, [contenteditable], dialog') || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'c' || k === 'p' || k === 'l' || k === 't') { e.preventDefault(); toWhatsUp({ type: 'key', key: k }) }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', active, { passive: true })
    window.addEventListener('wheel', active, { passive: true })
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', active); window.removeEventListener('wheel', active) }
  }, [])

  // the sidebar only redraws when its numbers really change (not on every keystroke in search)
  const today = todayKey()
  const active = useMemo(() => tasks.filter((t) => !t.done), [tasks])
  // the number on Whats Up's Todolist button: what's due today (and anything overdue)
  const dueNow = useMemo(() => active.filter((t) => t.due && t.due <= today).length, [active, today])
  useEffect(() => { if (data) toWhatsUp({ type: 'badge', due: dueNow }) }, [dueNow, !!data])
  const tagsKey = [...new Set(tasks.flatMap((t) => t.tags))].sort().join('\n')
  const tags = useMemo(() => (tagsKey ? tagsKey.split('\n') : []), [tagsKey])
  const countsKey = JSON.stringify([
    active.filter((t) => t.due === today).length,
    active.filter((t) => t.due && t.due < today).length,
    active.filter((t) => t.due && t.due > today).length,
    active.length,
    active.filter((t) => !t.listId).length,
    lists.map((l) => [l.id, active.filter((t) => t.listId === l.id).length]),
  ])
  const counts = useMemo<Counts>(() => {
    const [today, overdue, upcoming, all, inbox, perList] = JSON.parse(countsKey)
    return { today, overdue, upcoming, all, inbox, lists: Object.fromEntries(perList) }
  }, [countsKey])

  // row handlers that never change identity, so memoised rows skip redrawing
  const onDeleteRow = useEvent((t: Task) => remove(t))
  const onToggleRow = useEvent((t: Task, e: MouseEvent) => toggle(t, e))
  const handlers = useMemo(() => ({ onOpen: expand, onDetails: open, onDelete: onDeleteRow, onToggle: onToggleRow }), [expand, open, onDeleteRow, onToggleRow])
  const sideNavigate = useCallback((v: View) => { navigate(v); setMenu(false); setPeek(false) }, [navigate])
  // on phones these open from the slide-out menu: close it, so closing the dialog lands you back on your page
  const sideNewList = useCallback(() => { setMenu(false); setListDialog({}) }, [])
  const sideEditList = useCallback((l: List) => { setMenu(false); setListDialog({ list: l }) }, [])
  const sideListsUi = useEvent(setPrefs)
  const sideSettings = useCallback(() => { setMenu(false); setSettings(true) }, [])
  const sideDeleteList = useCallback((l: List) => { setMenu(false); setDeleting(l) }, [])
  const sideSignOut = useEvent(() => signOut())
  const sideWhatsApp = useEvent(() => openWhatsApp())
  const sideNewGroup = useEvent(() => { setMenu(false); setGroupDialog({}) })

  if (!data) return <div className="boot" aria-busy="true" />

  // ---------------------------------------------------------------- actions
  /** Tap the round button: Not started → In progress → Completed → Not started. */
  const toggle = (t: Task, e?: MouseEvent) => changeStatus(t, nextStatus(statusOf(t)), e)
  const changeStatus = (t: Task, status: TaskStatus, e?: MouseEvent) => {
    const before = statusOf(t)
    if (status === before) return
    // finishing a repeating task adds the next one, so ask first (it's easy to tap by accident)
    if (status === 'done' && t.repeat) { setConfirmRepeat({ task: t, x: e?.clientX, y: e?.clientY }); return }
    complete(t, status, before, e && { x: e.clientX, y: e.clientY })
  }
  const complete = (t: Task, status: TaskStatus, before: TaskStatus, at?: { x?: number; y?: number }) => {
    actions.updateTask(t.id, { status })
    if (status !== 'done') return
    const dueToday = tasks.filter((x) => x.due === today)
    const allTodayDone = t.due === today && dueToday.length > 1 && dueToday.every((x) => x.id === t.id || x.done)
    if (prefs.celebrate) {
      if (allTodayDone) rain()
      else if (at?.x !== undefined && at.y !== undefined) celebrate(at.x, at.y)
    }
    const next = t.repeat ? nextOccurrence(t.due, t.repeat) : null
    const msg = allTodayDone ? 'Everything due today is done 🎉' : next ? `Done. Next one: ${formatDay(next)} ↻` : `Done: ${t.title}`
    toast(msg, { label: 'Undo', run: () => actions.updateTask(t.id, { status: before }) })
  }
  const remove = (t: Task) => {
    setSelectedId(null)
    setExpandedId(null)
    actions.deleteTask(t.id)
    toast(`Deleted "${t.title}"`, { label: 'Undo', run: () => actions.restoreTask(t) })
  }
  const deleteList = async (l: List, deleteTasks: boolean) => {
    setDeleting(null)
    // switch page first, so the "list no longer exists → Today" fallback doesn't win
    if (view.kind === 'list' && view.id === l.id) { setView({ kind: 'all' }); navigate({ kind: 'all' }) }
    const r = await actions.deleteList(l.id, deleteTasks)
    if (!r) return
    const n = r.tasks.length
    toast(`Deleted list "${l.name}"${n ? ` and ${n} task${n === 1 ? '' : 's'}` : ''}`, {
      label: 'Undo',
      run: async () => { const back = await actions.restoreList(r as DeletedList); if (back) toast(`"${l.name}" is back`) },
    })
  }
  const showTodo = () => { setStatus('active'); navigate({ kind: 'all' }) }
  // back to WhatsApp: inside Whats Up, just switch tabs; on its own, go to your chats
  const openWhatsApp = () => {
    if (framed) toWhatsUp({ type: 'close' })
    else location.href = me.home
  }
  // one account for both: signing out here signs you out of Whats Up
  const signOut = async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
    try { if (framed) { window.top!.location.href = '/'; return } } catch {}
    location.href = '/'
  }

  // --------------------------------------------------------- what to show
  const q = deferredSearch.trim().toLowerCase()
  const matches = (t: Task) =>
    !q || t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q) || t.tags.some((x) => x.includes(q.replace(/^#/, '')))

  let title = ''
  let subtitle = ''
  let emoji = ''
  let defaults: TaskInput = {}
  let groups: Group[] = []
  let canSort = false
  let showList = true
  let listTools = false // status filter + sort
  let empty = 'Nothing here yet.'

  const doingFirst = (a: Task, b: Task) => Number(statusOf(b) === 'doing') - Number(statusOf(a) === 'doing')
  let scope: Task[] = [] // everything this page is about, for the status bar
  const doneSorted = (xs: Task[]) => xs.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
  // the finished tasks at the bottom of a page roll up (remembered on this device)
  const foldDone = { folded: prefs.doneFolded, onFold: () => setPrefs({ doneFolded: !prefs.doneFolded }) }
  const statusGroups = (xs: Task[]): Group[] => {
    // in-progress tasks first, unless you've arranged your own order
    const open = xs.filter((t) => !t.done).sort((a, b) => (sort === 'manual' ? 0 : doingFirst(a, b)) || SORTS[sort](a, b))
    return [
      ...(status !== 'done' ? [{ key: 'open', tasks: open }] : []),
      ...(status !== 'active' ? [{ key: 'done', title: status === 'all' ? 'Completed' : undefined, tasks: doneSorted(xs), ...(status === 'all' ? foldDone : {}) }] : []),
    ]
  }

  switch (view.kind) {
    case 'today': {
      const d = new Date()
      title = 'Today'
      subtitle = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}${holidayName(today) ? ` · 🎉 ${holidayName(today)}` : ''}`
      defaults = { due: today }
      const byTime = (a: Task, b: Task) => doingFirst(a, b) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority || byOrder(a, b)
      groups = [
        { key: 'overdue', title: 'Overdue', tone: 'danger', tasks: active.filter((t) => t.due && t.due < today && matches(t)).sort((a, b) => doingFirst(a, b) || byDue(a, b)) },
        { key: 'today', title: 'Today', tasks: active.filter((t) => t.due === today && matches(t)).sort(byTime) },
        { key: 'done', title: 'Done today', tasks: doneSorted(tasks.filter((t) => matches(t) && (t.due === today || (t.doneAt && toKey(new Date(t.doneAt)) === today)))), ...foldDone },
      ]
      scope = groups.flatMap((g) => g.tasks)
      empty = 'Nothing due today.'
      break
    }
    case 'upcoming': {
      title = 'Upcoming'
      defaults = { due: addDays(today, 1) }
      const future = active.filter((t) => t.due && t.due > today && matches(t)).sort(byDue)
      const days = Array.from({ length: 14 }, (_, i) => addDays(today, i + 1))
      groups = [
        ...days.map((k) => ({ key: k, title: `${formatDay(k)}${daysBetween(today, k) > 1 ? ` · ${fromKey(k).getDate()} ${MONTHS[fromKey(k).getMonth()].slice(0, 3)}` : ''}${holidayName(k) ? ` · 🎉 ${holidayName(k)}` : ''}`, tasks: future.filter((t) => t.due === k) })),
        { key: 'later', title: 'Later', tasks: future.filter((t) => t.due! > days[days.length - 1]) },
      ]
      scope = tasks.filter((t) => t.due && t.due > today && matches(t))
      empty = 'Nothing coming up.'
      break
    }
    case 'all':
      title = 'All tasks'
      scope = tasks.filter(matches)
      groups = statusGroups(scope)
      canSort = true
      listTools = true
      break
    case 'inbox':
      title = 'No list'
      scope = tasks.filter((t) => !t.listId && matches(t))
      groups = statusGroups(scope)
      canSort = true
      listTools = true
      showList = false
      break
    case 'list': {
      const l = listById.get(view.id)
      title = l?.name || ''
      emoji = l?.emoji || ''
      defaults = { listId: view.id }
      scope = tasks.filter((t) => t.listId === view.id && matches(t))
      groups = statusGroups(scope)
      canSort = true
      listTools = true
      showList = false
      break
    }
    case 'tag':
      title = `#${view.tag}`
      defaults = { tags: [view.tag] }
      scope = tasks.filter((t) => t.tags.includes(view.tag) && matches(t))
      groups = statusGroups(scope)
      canSort = true
      listTools = true
      break
    case 'completed': {
      title = 'Completed'
      const done = doneSorted(tasks.filter(matches))
      const keys = [...new Set(done.map((t) => toKey(new Date(t.doneAt || t.updatedAt))))]
      groups = keys.map((k) => ({ key: k, title: formatDay(k), tasks: done.filter((t) => toKey(new Date(t.doneAt || t.updatedAt)) === k) }))
      empty = 'Nothing finished yet.'
      break
    }
    case 'calendar':
      title = 'Calendar'
      break
    case 'stats':
      title = 'Stats'
      break
    case 'board':
      title = 'Personalize It'
      emoji = '✨'
      break
    case 'group': {
      const g = groupsApi.groups?.find((x) => x.id === view.id)
      title = g?.name || (groupsApi.groups ? 'Group not found' : '')
      emoji = g?.emoji || ''
      scope = (g?.tasks || []) as Task[]
      break
    }
    case 'admin':
      title = 'Admin'
      break
  }
  const sortable = canSort && sort === 'manual' && !q
  const doneCountHere = groups.find((g) => g.key === 'done')?.tasks.length || 0
  const clearCompleted = () => {
    const n = view.kind === 'completed' ? tasks.filter((t) => t.done).length : doneCountHere
    if (confirm(`Delete ${n} completed task${n === 1 ? '' : 's'}${view.kind === 'list' ? ' in this list' : ''}? This can't be undone.`)) {
      actions.clearCompleted(view.kind === 'list' ? view.id : undefined)
    }
  }
  const clearButton = <button className="btn quiet sm" onClick={clearCompleted}>Clear completed</button>
  // "Clear completed" sits on the Completed group it clears, not above the whole list
  if (listTools && doneCountHere > 0) groups = groups.map((g) => (g.key === 'done' ? { ...g, title: g.title || 'Completed', action: clearButton } : g))
  const hasSearch = view.kind !== 'calendar' && view.kind !== 'stats' && view.kind !== 'board' && view.kind !== 'admin' && view.kind !== 'group'
  const hasStatusBar = view.kind !== 'calendar' && view.kind !== 'stats' && view.kind !== 'completed' && view.kind !== 'admin' && view.kind !== 'board'
  const wide = view.kind === 'calendar' || view.kind === 'stats' || view.kind === 'board' || view.kind === 'admin'

  const list = (gs: Group[], sortableHere: boolean, emptyText: string) => (
    <TaskList
      groups={gs}
      lists={lists}
      showList={showList}
      selectedId={selectedId}
      expandedId={expandedId}
      renderInline={(t) => (
        <InlineEditor
          task={t}
          lists={lists}
          weekStartsMonday={prefs.weekStartsMonday}
          onChange={(patch) => actions.updateTask(t.id, patch)}
          onStatus={(st) => changeStatus(t, st)}
          onCollapse={collapse}
          onDetails={() => open(t)}
          onNewList={() => setListDialog({})}
          waOn={me.whatsapp.buddy}
        />
      )}
      sortable={sortableHere}
      handlers={handlers}
      onReorder={actions.reorderTasks}
      empty={emptyText}
    />
  )

  return (
    <div
      className={`app${selected ? ' with-editor' : ''}${prefs.sidebarCollapsed ? ' side-collapsed' : ''}${view.kind === 'board' ? ' view-board' : ''}`}
      data-hide-progress={prefs.showProgress ? undefined : ''}
      data-hide-status={prefs.showStatus ? undefined : ''}
      style={{ '--side-w': `${prefs.sidebarWidth}px` } as CSSProperties}
    >
      {prefs.sidebarCollapsed && (
        <>
          {/* collapsed: a small rail to get the sidebar back; hover peeks, click pins it open */}
          <div className="side-rail" onMouseEnter={() => peekSidebar(true)} onMouseLeave={() => peekSidebar(false)}>
            <Mark size={30} />
            <button className="icon-btn" onClick={toggleSidebar} aria-label="Show sidebar" title="Show sidebar ([)">
              <SidebarIcon />
            </button>
          </div>
          <div className="side-hotzone" onMouseEnter={() => peekSidebar(true)} aria-hidden="true" />
        </>
      )}
      <Sidebar
        me={me}
        view={view}
        lists={lists}
        tags={tags}
        counts={counts}
        online={online}
        open={menu}
        collapsed={prefs.sidebarCollapsed}
        peek={peek}
        onCollapse={toggleSidebar}
        onPeek={peekSidebar}
        onReorderLists={actions.reorderLists}
        onNavigate={sideNavigate}
        onNewList={sideNewList}
        onEditList={sideEditList}
        onDeleteList={sideDeleteList}
        listsCollapsed={prefs.listsCollapsed}
        listsShowAll={prefs.listsShowAll}
        onListsUi={sideListsUi}
        onSettings={sideSettings}
        onSignOut={sideSignOut}
        onWhatsApp={sideWhatsApp}
        groups={groupsApi.groups}
        onNewGroup={sideNewGroup}
      />
      {!prefs.sidebarCollapsed && <ResizeHandle width={prefs.sidebarWidth} onResize={(w) => setPrefs({ sidebarWidth: w })} />}
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}

      <main className="main" ref={mainRef}>
        {/* keyed by page: each page fades in as you arrive */}
        <div key={toHash(view)} className={`page${wide ? ' wide' : ''} page-${view.kind}`}>
          <header className="main-head">
            {framed && (
              <button className="icon-btn wa-back wa-brand-btn" onClick={openWhatsApp} aria-label="Back to Whats Up chats" title="Back to Whats Up chats">
                <WhatsUpLogo size={22} />
              </button>
            )}
            <button className="icon-btn menu-btn" onClick={() => setMenu(true)} aria-label="Open menu">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6h13M3.5 10h13M3.5 14h13" /></svg>
            </button>
            <div className="title-block">
              <h1>
                {emoji && <span className="title-emoji">{emoji}</span>}{title}
                {view.kind === 'list' && listById.get(view.id) && (
                  <ListMenu list={listById.get(view.id)!} className="icon-btn title-menu" onEdit={() => setListDialog({ list: listById.get(view.id) })} onDelete={() => setDeleting(listById.get(view.id)!)} />
                )}
              </h1>
              {subtitle && <p className="subtitle">{subtitle}</p>}
            </div>
            <div className="head-tools">
              {view.kind === 'stats' && <Fire days={streakDays(tasks)} />}
              {view.kind === 'completed' && groups.some((g) => g.tasks.length) && clearButton}
              {hasSearch && <SearchBox value={search} onChange={setSearch} />}
            </div>
          </header>

          {announcements.filter((a) => !hiddenAnn.includes(a.id)).slice(0, 2).map((a) => (
            <div key={a.id} className="nudge announce" role="status">
              <span>📣 <b>{a.title}</b>{a.body && <> · {a.body}</>}</span>
              <button className="icon-btn sm" aria-label="Dismiss" onClick={() => hideAnn(a.id)}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
              </button>
            </div>
          ))}
          {showNudge && (
            <div className="nudge" role="status">
              <span>You have reminders set, but notifications are off on this device.</span>
              <button className="btn sm" onClick={async () => {
                try { await enablePush(); setPushOn(true); toast('Notifications on') } catch (e: any) { toast(e.message) }
              }}>Turn on</button>
              <button className="icon-btn sm" aria-label="Not now" onClick={() => { setNudgeHidden(true); try { localStorage.setItem('todo-push-nudge', 'no') } catch {} }}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
              </button>
            </div>
          )}
          {hasStatusBar && <StatusBar tasks={scope} label={title} />}

          {view.kind === 'board' ? (
            <BoardView
              board={data.board || { widgets: DEFAULT_WIDGETS.map((w, i) => ({ ...w, id: `d${i}` })) }}
              onSave={actions.saveBoard}
              env={{
                tasks, lists, onOpen: open, onToggle: toggle, onStatus: (t, st) => changeStatus(t, st),
                onUpdate: actions.updateTask, onAdd: actions.addTask, onReorder: actions.reorderTasks, onShowTodo: showTodo,
              }}
            />
          ) : view.kind === 'group' ? (
            (() => {
              const g = groupsApi.groups?.find((x) => x.id === view.id)
              if (!g) return <div className="empty">{groupsApi.groups ? 'You’re not in this group.' : 'Loading…'}</div>
              return <GroupView group={g} me={me.username} actions={groupsApi} onEdit={() => setGroupDialog({ group: g })} />
            })()
          ) : view.kind === 'admin' ? (
            me.admin ? <AdminView me={me.username} /> : <div className="empty">Only the admin can see this page.</div>
          ) : view.kind === 'stats' ? (
            <StatsView tasks={tasks} lists={lists} onOpen={open} onShowTodo={showTodo} onShowOverdue={() => navigate({ kind: 'today' })} overdueShowAll={prefs.overdueShowAll} onOverdueShowAll={(on) => setPrefs({ overdueShowAll: on })} />
          ) : view.kind === 'calendar' ? (
            <div className={`cal-layout${day ? ' has-panel' : ''}`}>
              <CalendarView
                tasks={tasks}
                lists={lists}
                weekStartsMonday={prefs.weekStartsMonday}
                selected={day}
                onSelect={setDay}
                onOpen={open}
                onMove={(t, d) => { actions.updateTask(t.id, { due: d }); toast(`Moved to ${formatDay(d)}`) }}
                mode={prefs.calendarMode}
                onMode={(m) => setPrefs({ calendarMode: m })}
                range={prefs.calendarRange}
                onRange={(r) => setPrefs({ calendarRange: r })}
                holidays={holidays}
                dayNotes={data.dayNotes || {}}
              />
              {day && (
                <DayPanel key={day} label={`Tasks for ${formatDay(day)}`}>
                  <div className="day-head">
                    <h2>{formatDay(day)}{daysBetween(today, day) !== 0 && <span className="muted"> · {fromKey(day).getDate()} {MONTHS[fromKey(day).getMonth()]}</span>}</h2>
                    <button className="icon-btn" onClick={() => setDay(null)} aria-label="Close day" title="Close (Esc)">
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
                    </button>
                  </div>
                  {holidayName(day) && <p className="day-holiday">🎉 {holidayName(day)}</p>}
                  <DayNote
                    key={`note-${day}`}
                    date={day}
                    note={data.dayNotes?.[day]}
                    onSave={(n) => actions.setDayNote(day, n)}
                    onDelete={() => actions.deleteDayNote(day)}
                  />
                  <NewTaskForm
                    key={day}
                    lists={lists}
                    defaults={{ due: day }}
                    placeholder={`Add a task for ${formatDay(day) === 'Today' ? 'today' : formatDay(day)}…`}
                    weekStartsMonday={prefs.weekStartsMonday}
                    onAdd={actions.addTask}
                    onNewList={() => setListDialog({})}
                    waOn={me.whatsapp.buddy}
                  />
                  {list(
                    [
                      { key: 'open', tasks: active.filter((t) => t.due === day).sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority) },
                      { key: 'done', title: 'Done', tasks: tasks.filter((t) => t.due === day && t.done), ...foldDone },
                    ],
                    false,
                    'Nothing on this day.',
                  )}
                </DayPanel>
              )}
            </div>
          ) : (
            <>
              {view.kind !== 'completed' && (
                <NewTaskForm
                  key={toHash(view)}
                  lists={lists}
                  defaults={defaults}
                  weekStartsMonday={prefs.weekStartsMonday}
                  onAdd={actions.addTask}
                  onNewList={() => setListDialog({})}
                  waOn={me.whatsapp.buddy}
                />
              )}
              {listTools && (
                <div className="toolbar">
                  <div className="seg" role="radiogroup" aria-label="Show">
                    {(['all', 'active', 'done'] as Status[]).map((s) => (
                      <button key={s} role="radio" aria-checked={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                        {s === 'all' ? 'All' : s === 'active' ? 'To do' : 'Done'}
                      </button>
                    ))}
                  </div>
                  <label className="sort">
                    <span>Sort</span>
                    <select className="input sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                      <option value="manual">My order (drag)</option>
                      <option value="due">Due date</option>
                      <option value="priority">Priority</option>
                      <option value="newest">Newest</option>
                    </select>
                  </label>
                </div>
              )}
              {list(groups, sortable, q ? `No tasks match "${deferredSearch}".` : empty)}
            </>
          )}
        </div>
      </main>

      {selected && (
        <>
          <div className="scrim editor-scrim" onClick={() => setSelectedId(null)} />
          <TaskEditor
            key={selected.id}
            task={selected}
            lists={lists}
            weekStartsMonday={prefs.weekStartsMonday}
            onNewList={() => setListDialog({})}
            onChange={(patch) => actions.updateTask(selected.id, patch)}
            onToggle={() => toggle(selected)}
            onStatus={(st) => changeStatus(selected, st)}
            onDelete={() => remove(selected)}
            onClose={() => setSelectedId(null)}
            onShare={me.whatsapp.share ? () => setSharing(selected) : undefined}
            waOn={me.whatsapp.buddy}
          />
        </>
      )}
      {sharing && (
        <ChatPicker
          taskTitle={sharing.title}
          onPick={(jid) => api('/wa/share', 'POST', { taskId: sharing.id, jid })}
          onClose={() => setSharing(null)}
          onSent={(name) => { setSharing(null); toast(`Sent to ${name} on WhatsApp`) }}
        />
      )}

      {deleting && (() => {
        const n = tasks.filter((t) => t.listId === deleting.id).length
        return (
          <ConfirmDialog
            title={`Delete list "${deleting.name}"?`}
            confirmLabel={n ? 'Keep the tasks' : 'Delete list'}
            danger={!n}
            onCancel={() => setDeleting(null)}
            onConfirm={() => deleteList(deleting, false)}
            secondary={n ? { label: `Delete the ${n === 1 ? 'task' : `${n} tasks`} too`, danger: true, onClick: () => deleteList(deleting, true) } : undefined}
          >
            {n
              ? <>It has <b>{n} task{n === 1 ? '' : 's'}</b>. Keep them (they move to <b>No list</b>) or delete them too? You can undo either way.</>
              : <>The list is empty. You can undo this.</>}
          </ConfirmDialog>
        )
      })()}
      {tour && (
        <Tour
          steps={tourSteps({
            me,
            navigate: (v) => { setSelectedId(null); setExpandedId(null); setMenu(false); navigate(v) },
            showTodo,
            showLists: () => setPrefs({ listsCollapsed: false }),
            // phones: the sidebar is a drawer, so open it for the steps about it (after the page change settles)
            openMenu: () => { if (window.innerWidth <= 860) window.setTimeout(() => setMenu(true), 60) },
          })}
          onEnd={endTour}
        />
      )}
      {confirmRepeat && (() => {
        const t = confirmRepeat.task
        const next = t.repeat ? nextOccurrence(t.due, t.repeat) : null
        return (
          <ConfirmDialog
            title={`Complete "${t.title}"?`}
            confirmLabel="Complete"
            onCancel={() => setConfirmRepeat(null)}
            onConfirm={() => {
              setConfirmRepeat(null)
              const now = tasks.find((x) => x.id === t.id) || t
              complete(now, 'done', statusOf(now), confirmRepeat)
            }}
          >
            {next ? <>It repeats. The next one is on <b>{formatDay(next)}</b>.</> : <>It repeats, but this was the last one.</>}
          </ConfirmDialog>
        )
      })()}
      {reminderSetup && !tour && (
        <ReminderSetupDialog
          me={me}
          pushOn={reminderPushOn}
          setPushOn={setReminderPushOn}
          waOn={reminderWaOn}
          setWaOn={setReminderWaOn}
          onConfirm={finishReminderSetup}
          onLater={() => { try { localStorage.setItem(`todo-reminder-setup:${me.username}`, '1') } catch {}; setReminderSetup(false) }}
        />
      )}
      {groupDialog && (
        <GroupDialog
          group={groupDialog.group}
          me={me.username}
          onClose={() => setGroupDialog(null)}
          onSave={async (v) => {
            if (groupDialog.group) await groupsApi.update(groupDialog.group.id, v)
            else { const g = await groupsApi.create({ ...v, members: v.members || [me.username] }); if (g) navigate({ kind: 'group', id: g.id }) }
          }}
          onLeave={groupDialog.group ? async () => { const id = groupDialog.group!.id; await groupsApi.leave(id); navigate({ kind: 'today' }) } : undefined}
          onDelete={groupDialog.group ? async () => { const id = groupDialog.group!.id; await groupsApi.remove(id); navigate({ kind: 'today' }) } : undefined}
        />
      )}
      {listDialog && (
        <ListDialog
          list={listDialog.list}
          onClose={() => setListDialog(null)}
          onSave={async (v) => {
            if (listDialog.list) actions.updateList(listDialog.list.id, v)
            else {
              const l = await actions.addList(v)
              if (l) navigate({ kind: 'list', id: l.id })
            }
          }}
          onDelete={listDialog.list ? () => setDeleting(listDialog.list!) : undefined}
        />
      )}
      {settings && (
        <SettingsDialog
          me={me}
          prefs={prefs}
          setPrefs={setPrefs}
          onClose={() => setSettings(false)}
          onWaReminders={async (on) => {
            try { setMe(await api<Me>('/profile', 'PATCH', { waReminders: on })); toast(on ? 'WhatsApp reminders on' : 'WhatsApp reminders off') } catch (e: any) { toast(e.message) }
          }}
          onTour={() => { setSettings(false); setTour(true) }}
          onBuddy={async (b) => {
            try { setMe(await api<Me>('/profile', 'PATCH', { buddy: b })) } catch (e: any) { toast(e.message) }
          }}
          onHolidayCountry={async (c) => {
            try { setMe(await api<Me>('/profile', 'PATCH', { holidayCountry: c })) } catch (e: any) { toast(e.message) }
          }}
          onAppearance={(a: Appearance) => {
            // live preview straight away; save once the picker settles
            clearTimeout(saveAppearance.current)
            saveAppearance.current = window.setTimeout(async () => {
              try { setMe(await api<Me>('/profile', 'PATCH', { appearance: a })) } catch (e: any) { toast(e.message); applyAppearance(me.appearance) }
            }, 400)
          }}
          onRename={async (name) => {
            try {
              setMe(await api<Me>('/profile', 'PATCH', { name }))
              toast('Name saved')
            } catch (e: any) { toast(e.message) }
          }}
        />
      )}
    </div>
  )
}

/**
 * The calendar's day panel. Beside the calendar on wide screens; on narrower ones it sits
 * under the calendar, so it scrolls itself into view when it opens (you see what you clicked).
 */
function DayPanel({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || matchMedia('(min-width: 1181px)').matches) return
    const r = el.getBoundingClientRect()
    if (r.top > window.innerHeight * 0.5 || r.top < 0) {
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    }
  }, [])
  return <section ref={ref} className="day-panel" aria-label={label}>{children}</section>
}

function ReminderSetupDialog({ me, pushOn, setPushOn, waOn, setWaOn, onConfirm, onLater }: {
  me: Me
  pushOn: boolean
  setPushOn: (v: boolean) => void
  waOn: boolean
  setWaOn: (v: boolean) => void
  onConfirm: () => void
  onLater: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal() }, [])
  const pushReady = pushSupport() === 'ok'
  const waReady = me.whatsapp.configured && me.whatsapp.reminders
  return (
    <dialog ref={ref} className="dialog reminder-setup" onCancel={(e) => { e.preventDefault(); onLater() }} onClick={(e) => { if (e.target === ref.current) onLater() }} aria-labelledby="reminder-setup-title">
      <div className="dialog-inner">
        <h2 id="reminder-setup-title">How should we remind you?</h2>
        <p className="help reminder-setup-intro">Nothing is sent until you set a reminder on a task. You can change this later in Settings.</p>
        <div className="reminder-choice-list">
          <label className="toggle tight">
            <input type="checkbox" checked={pushOn} disabled={!pushReady} onChange={(e) => setPushOn(e.target.checked)} />
            <span><b>Notifications on this device</b><small>{pushReady ? ' Pop-ups, even when the site is closed.' : ` ${supportMessage(pushSupport()) || 'Not available in this browser.'}`}</small></span>
          </label>
          <label className="toggle tight">
            <input type="checkbox" checked={waOn} disabled={!waReady} onChange={(e) => setWaOn(e.target.checked)} />
            <span><b>WhatsApp reminders</b><small>{waReady ? ' Reminders also go to your WhatsApp.' : ' Link WhatsApp first.'}</small></span>
          </label>
        </div>
        <div className="dialog-actions reminder-setup-actions">
          <button className="btn ghost" onClick={onLater}>Not now</button>
          <button className="btn" onClick={onConfirm}>Save</button>
        </div>
      </div>
    </dialog>
  )
}
