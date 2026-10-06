import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { toast } from './components/Toast'
import type { Exam, ExamRequest, ExamsData, School } from './types'

export type ExamInput = Partial<Omit<Exam, 'id' | 'at'>>

/**
 * The Exams page's data: your school's timetable and your requests (admins: any
 * school, every request), kept live: an "exams" event from the server reloads it.
 */
export function useExams() {
  const [data, setData] = useState<ExamsData | null>(null)
  const [school, setSchool] = useState<string | undefined>(undefined) // admins looking at another school
  const schoolRef = useRef(school)
  schoolRef.current = school
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    const q = schoolRef.current ? `?school=${encodeURIComponent(schoolRef.current)}` : ''
    try { setData(await api<ExamsData>(`/exams${q}`)) } catch (e: any) { toast(e.message) }
  }, [])

  useEffect(() => { load() }, [load, school])
  useEffect(() => {
    const onEv = (e: Event) => {
      if ((e as CustomEvent).detail?.type !== 'exams') return
      clearTimeout(timer.current)
      timer.current = window.setTimeout(load, 200)
    }
    const onShow = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('todo:event', onEv)
    document.addEventListener('visibilitychange', onShow)
    return () => { window.removeEventListener('todo:event', onEv); document.removeEventListener('visibilitychange', onShow); clearTimeout(timer.current) }
  }, [load])

  /** Run a change; on success reload, on failure say why. Returns the answer, or null. */
  const run = async <T,>(p: Promise<T>, done?: string): Promise<T | null> => {
    try {
      const r = await p
      if (done) toast(done)
      load()
      return r
    } catch (e: any) {
      toast(e.message)
      return null
    }
  }

  return {
    data,
    reload: load,
    /** Admins: which school's timetable to show ('all' for every school). */
    school,
    viewSchool: setSchool,
    setMine: (body: { school?: string | null; subjects?: string[] }) => run(api('/exams/me', 'PATCH', body)),
    request: (body: ExamInput) => run(api<ExamRequest>('/exams/requests', 'POST', body), 'Sent to the admin'),
    withdraw: (id: string) => run(api(`/exams/requests/${id}`, 'DELETE')),
    // admin
    addExam: (body: ExamInput) => run(api<Exam>('/admin/exams', 'POST', body), 'Exam added'),
    updateExam: (id: string, body: ExamInput) => run(api<Exam>(`/admin/exams/${id}`, 'PATCH', body), 'Saved'),
    deleteExam: (id: string) => run(api(`/admin/exams/${id}`, 'DELETE'), 'Exam deleted'),
    answer: (id: string, body: { approve: boolean; changes?: ExamInput; reason?: string }) =>
      run(api<ExamRequest>(`/admin/exams/requests/${id}`, 'POST', body), body.approve ? 'Added to the timetable' : 'Turned down'),
    addSchool: (name: string) => run(api<School>('/admin/schools', 'POST', { name })),
    updateSchool: (id: string, body: Partial<School>) => run(api<School>(`/admin/schools/${id}`, 'PATCH', body)),
    deleteSchool: (id: string) => run(api(`/admin/schools/${id}`, 'DELETE'), 'School deleted'),
    schoolPeople: () => api<{ username: string; name: string; school: string | null }[]>('/admin/schools/people'),
    setSchoolOf: (u: string, school: string | null) => run(api(`/admin/people/${u}/school`, 'PATCH', { school })),
  }
}

export type ExamsApi = ReturnType<typeof useExams>
