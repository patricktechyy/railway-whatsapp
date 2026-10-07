import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { toast } from './components/Toast'
import type { StudyPlan } from './types'

const EMPTY: StudyPlan = { rev: 0, subjects: [], tags: [], days: {}, tests: [], blocks: [] }

/**
 * Your study plan. Changes show straight away and are saved half a second after
 * you stop; if another device saved in between, the newer plan is loaded instead
 * (and you're told), so nothing is silently overwritten.
 */
export function useStudy() {
  const [plan, setPlan] = useState<StudyPlan | null>(null)
  const ref = useRef<StudyPlan>(EMPTY)
  const rev = useRef(0)
  const dirty = useRef(false)
  const saving = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const d = await api<StudyPlan>('/study')
      d.tags ||= []
      d.blocks = d.blocks.map((x) => ({ ...x, tags: x.tags || [], time: x.time ?? null, minutes: x.minutes ?? null, spent: x.spent || 0 }))
      rev.current = d.rev
      ref.current = d
      setPlan(d)
    } catch (e: any) { toast(e.message) }
  }, [])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!dirty.current || saving.current) return
    saving.current = true
    dirty.current = false
    try {
      const d = await api<StudyPlan>('/study', 'PUT', { ...ref.current, rev: rev.current })
      rev.current = d.rev
    } catch (e: any) {
      if (e.status === 409) { toast('Your plan was changed on another device. Showing the latest.'); await load() }
      else { toast(e.message); dirty.current = true }
    } finally {
      saving.current = false
      if (dirty.current) timer.current = window.setTimeout(flush, 800)
    }
  }, [load])

  /** Change the plan (shown at once, saved shortly after). */
  const change = useCallback((fn: (p: StudyPlan) => StudyPlan) => {
    const next = fn(ref.current)
    ref.current = next
    setPlan(next)
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 500)
  }, [flush])

  useEffect(() => {
    load()
    // another device saved: catch up (unless we're mid-edit; our save will sort it out)
    const onEv = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d?.type === 'study' && d.rev > rev.current && !dirty.current && !saving.current) load()
    }
    const away = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('todo:event', onEv)
    document.addEventListener('visibilitychange', away)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('todo:event', onEv)
      document.removeEventListener('visibilitychange', away)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [load, flush])

  return { plan, change }
}

export type StudyApi = ReturnType<typeof useStudy>
