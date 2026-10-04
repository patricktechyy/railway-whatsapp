import { useEffect, useState } from 'react'

export type Theme = 'auto' | 'light' | 'dark'
export interface Prefs {
  theme: Theme
  celebrate: boolean
  weekStartsMonday: boolean
  sidebarWidth: number
  sidebarCollapsed: boolean
  calendarMode: 'month' | 'week' | 'custom'
  calendarRange: { from: string; to: string } | null
  overdueShowAll: boolean
  showProgress: boolean
  showStatus: boolean
  listsCollapsed: boolean // Lists section rolled up in the sidebar
  listsShowAll: boolean // "View more": every list, not just the first 4
  doneFolded: boolean // the Completed / Done today group at the bottom of a page is rolled up
  defaultRemind: number | null // early reminder given to a task when it first gets a time
}
const DEFAULTS: Prefs = { theme: 'auto', celebrate: true, weekStartsMonday: true, sidebarWidth: 272, sidebarCollapsed: false, calendarMode: typeof window !== 'undefined' && window.innerWidth < 700 ? 'week' : 'month', calendarRange: null, overdueShowAll: false, showProgress: true, showStatus: true, defaultRemind: 0, listsCollapsed: false, listsShowAll: false, doneFolded: false }
const KEY = 'todo-prefs'

function read(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return DEFAULTS }
}

/** The early reminder a task gets when you first give it a time (Settings → Reminders). */
export const defaultRemind = () => read().defaultRemind

/** Per-device preferences (theme and so on), kept in this browser only. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(read)
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch {}
    const root = document.documentElement
    if (prefs.theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = prefs.theme
  }, [prefs])
  return [prefs, (p: Partial<Prefs>) => setPrefs((x) => ({ ...x, ...p }))] as const
}
