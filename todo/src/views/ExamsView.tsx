import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { addDays, daysBetween, formatTime, fromKey, MONTHS, todayKey, toKey, WEEKDAYS } from '../dates'
import { Dialog } from '../components/Dialogs'
import { Select } from '../components/Select'
import { toast } from '../components/Toast'
import type { Exam, ExamRequest, School } from '../types'
import type { ExamInput, ExamsApi } from '../useExams'
import { Icon } from '../components/Icon'

/**
 * Exams: your school's exam timetable, as a calendar or a list, counting down to
 * the next paper. The admin keeps it (and the list of schools); anyone can ask
 * for an exam to be added.
 */

const SUBJECT_COLORS = ['blue', 'orange', 'aqua', 'magenta', 'green', 'violet', 'yellow']
/** The same subject is always the same colour (on every page and device). */
export function subjectColor(subject: string) {
  let h = 0
  for (const ch of subject.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `c-${SUBJECT_COLORS[h % SUBJECT_COLORS.length]}`
}
const endOf = (start: string, minutes: number) => {
  const [h, m] = start.split(':').map(Number)
  const t = h * 60 + m + minutes
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}
/** "8:00 – 9:50 AM", "8:00 AM", or "" (no time set). */
export function examTime(e: Pick<Exam, 'start' | 'minutes'>) {
  if (!e.start) return ''
  if (!e.minutes) return formatTime(e.start)
  return `${formatTime(e.start)} – ${formatTime(endOf(e.start, e.minutes))}`
}
const lengthText = (m: number | null) => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`)
export const examTitle = (e: Pick<Exam, 'subject' | 'paper'>) => `${e.subject}${e.paper ? ` ${e.paper}` : ''}`
function countdown(date: string, today: string) {
  const n = daysBetween(today, date)
  return n < 0 ? 'Done' : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `in ${n} days`
}
const longDate = (k: string) => {
  const d = fromKey(k)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`
}

export function ExamsView({ exams: x, weekStartsMonday, onPlan }: { exams: ExamsApi; weekStartsMonday: boolean; onPlan?: () => void }) {
  const d = x.data
  const [mode, setMode] = useState<'calendar' | 'list'>(() => { try { return (localStorage.getItem('todo-exams-mode') as 'list') || 'list' } catch { return 'list' } })
  const [open, setOpen] = useState<Exam | null>(null)
  const [form, setForm] = useState<{ exam?: Exam; request?: ExamRequest; asRequest?: boolean } | null>(null)
  const [requests, setRequests] = useState(false)
  const [schools, setSchools] = useState(false)
  const today = todayKey()
  useEffect(() => { try { localStorage.setItem('todo-exams-mode', mode) } catch {} }, [mode])

  const schoolName = (id: string) => d?.schools.find((s) => s.id === id)?.name || ''
  const allSubjects = useMemo(() => [...new Set((d?.exams || []).map((e) => e.subject))].sort((a, b) => a.localeCompare(b)), [d])
  const mine = d?.subjects || []
  const shown = useMemo(() => {
    const subs = mine.map((s) => s.toLowerCase())
    return (d?.exams || []).filter((e) => !subs.length || subs.includes(e.subject.toLowerCase()))
  }, [d, mine])

  if (!d) return <div className="ex-page" aria-busy="true" />
  const pending = d.requests.filter((r) => r.status === 'pending')
  const showingAll = d.admin && d.showing === 'all'
  const noSchool = !d.admin && !d.school
  const lookingAt = d.admin ? (x.school || d.school || '') : d.school || ''

  const toggleSubject = (s: string) => {
    const has = mine.some((m) => m.toLowerCase() === s.toLowerCase())
    x.setMine({ subjects: has ? mine.filter((m) => m.toLowerCase() !== s.toLowerCase()) : [...mine, s] })
  }

  return (
    <div className="ex-page">
      <div className="ex-bar">
        {d.admin ? (
          <Select className="input sm" value={x.school || d.school || 'all'} onChange={(e) => x.viewSchool(e.target.value)} aria-label="Which school">
            <option value="all">All schools</option>
            {d.schools.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === d.school ? ' (yours)' : ''}</option>)}
          </Select>
        ) : d.school ? (
          // picked once; the admin changes it if it's wrong
          <span className="ex-school" title="Your admin can change this"><Icon name="school" />{schoolName(d.school)}</span>
        ) : null}
        {!noSchool && (
          <div className="seg sm" role="radiogroup" aria-label="Show as">
            <button role="radio" aria-checked={mode === 'list'} className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>List</button>
            <button role="radio" aria-checked={mode === 'calendar'} className={mode === 'calendar' ? 'on' : ''} onClick={() => setMode('calendar')}>Calendar</button>
          </div>
        )}
        <span className="spacer" />
        {d.admin ? (
          <>
            <button className="btn ghost sm" onClick={() => setSchools(true)}>Schools</button>
            <button className="btn ghost sm ex-req-btn" onClick={() => setRequests(true)}>Requests{pending.length > 0 && <span className="tab-count">{pending.length}</span>}</button>
            <button className="btn sm" disabled={!d.schools.length} title={d.schools.length ? '' : 'Add a school first'} onClick={() => setForm({})}>+ Add exam</button>
          </>
        ) : !noSchool && (
          <button className="btn ghost sm" onClick={() => setForm({ asRequest: true })}>Request an exam</button>
        )}
      </div>

      {d.admin && !d.schools.length && (
        <div className="ex-empty card">
          <h3>Start with a school</h3>
          <p className="help">Exams belong to a school, so people only see their own school’s.</p>
          <button className="btn sm" onClick={() => setSchools(true)}>Add a school</button>
        </div>
      )}

      {noSchool ? (
        <PickSchool schools={d.schools} onPick={(id) => x.setMine({ school: id })} />
      ) : (
        <>
          {!showingAll && <NextUp exams={shown} today={today} onOpen={setOpen} onPlan={onPlan} />}

          {allSubjects.length > 1 && !d.admin && (
            <div className="ex-subjects" role="group" aria-label="Your subjects">
              <span className="ex-sub-label">Your subjects</span>
              {allSubjects.map((s) => {
                const on = mine.some((m) => m.toLowerCase() === s.toLowerCase())
                return (
                  <button key={s} className={`ex-chip ${subjectColor(s)}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleSubject(s)}>
                    <i className="swatch" aria-hidden="true" />{s}
                  </button>
                )
              })}
              {mine.length > 0 ? <button className="linkish" onClick={() => x.setMine({ subjects: [] })}>Show all</button> : <span className="help ex-sub-hint">Tap yours to hide the rest</span>}
            </div>
          )}

          {mode === 'calendar'
            ? <ExamMonth exams={shown} today={today} weekStartsMonday={weekStartsMonday} schoolName={showingAll ? schoolName : null} onOpen={setOpen} />
            : <ExamList exams={shown} today={today} weekStartsMonday={weekStartsMonday} schoolName={showingAll ? schoolName : null} onOpen={setOpen} />}

          {!d.admin && d.requests.length > 0 && <MyRequests requests={d.requests} onWithdraw={x.withdraw} />}
        </>
      )}

      {open && (
        <ExamDetails
          exam={open}
          school={schoolName(open.school)}
          admin={d.admin}
          today={today}
          onClose={() => setOpen(null)}
          onEdit={() => { setForm({ exam: open }); setOpen(null) }}
          onDelete={async () => { if (confirm(`Delete ${examTitle(open)} on ${longDate(open.date)}?`)) { await x.deleteExam(open.id); setOpen(null) } }}
        />
      )}
      {form && (
        <ExamForm
          initial={form.exam || form.request}
          schools={d.schools}
          school={form.exam?.school || form.request?.school || (lookingAt && lookingAt !== 'all' ? lookingAt : d.schools[0]?.id) || ''}
          subjects={allSubjects}
          mode={form.asRequest ? 'request' : form.request ? 'approve' : form.exam ? 'edit' : 'add'}
          onClose={() => setForm(null)}
          onSave={async (body) => {
            const r = form.asRequest ? await x.request(body)
              : form.request ? await x.answer(form.request.id, { approve: true, changes: body })
              : form.exam ? await x.updateExam(form.exam.id, body)
              : await x.addExam(body)
            if (r) setForm(null)
          }}
        />
      )}
      {requests && (
        <RequestsDialog
          requests={pending}
          schoolName={schoolName}
          onClose={() => setRequests(false)}
          onAdd={(r) => x.answer(r.id, { approve: true })}
          onEdit={(r) => { setForm({ request: r }); setRequests(false) }}
          onDecline={(r) => {
            const reason = prompt(`Why not add ${examTitle(r)}? (optional, ${r.byName || r.by} will see this)`)
            if (reason !== null) x.answer(r.id, { approve: false, reason })
          }}
        />
      )}
      {schools && <SchoolsDialog schools={d.schools} api={x} onClose={() => setSchools(false)} />}
    </div>
  )
}

// ------------------------------------------------------------------ parts
function PickSchool({ schools, onPick }: { schools: School[]; onPick: (id: string) => void }) {
  const [sid, setSid] = useState(schools[0]?.id || '')
  return (
    <div className="ex-empty card">
      <div className="ex-empty-icon"><Icon name="school" /></div>
      <h3>Which school are you at?</h3>
      {schools.length ? (
        <>
          <p className="help">You’ll see its exam timetable here, and in your study planner.</p>
          <div className="row ex-pick">
            <Select className="input" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Your school">
              {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <button className="btn" disabled={!sid} onClick={() => onPick(sid)}>Done</button>
          </div>
          <p className="help">You can’t change it yourself afterwards, so pick carefully. Not on the list? Ask your admin to add it.</p>
        </>
      ) : (
        <p className="help">No schools yet. Your admin adds them.</p>
      )}
    </div>
  )
}

/** The next paper, big, with a countdown, and how far through the exams you are. */
function NextUp({ exams, today, onOpen, onPlan }: { exams: Exam[]; today: string; onOpen: (e: Exam) => void; onPlan?: () => void }) {
  const next = exams.find((e) => e.date >= today)
  if (!next) {
    return exams.length ? <div className="ex-next done card"><span className="ex-next-big"><Icon name="done" /></span><div><b>All done</b><p className="help">No more exams on the timetable.</p></div></div> : null
  }
  const n = daysBetween(today, next.date)
  // "this exam period": the papers within a few weeks either side of the next one
  const season = exams.filter((e) => Math.abs(daysBetween(next.date, e.date)) <= 28)
  const done = season.filter((e) => e.date < today).length
  const sameDay = exams.filter((e) => e.date === next.date && e.id !== next.id)
  return (
    <div className={`ex-next card ${subjectColor(next.subject)}`}>
      <button className="ex-next-count" onClick={() => onOpen(next)} aria-label={`Next exam ${countdown(next.date, today)}`}>
        <span className="ex-next-big">{n <= 0 ? 'Today' : n}</span>
        {n > 0 && <span className="ex-next-unit">{n === 1 ? 'day' : 'days'}</span>}
      </button>
      <div className="ex-next-body">
        <span className="ex-next-label">Next exam</span>
        <button className="ex-next-title" onClick={() => onOpen(next)}>{examTitle(next)}</button>
        <span className="ex-next-meta">{longDate(next.date)}{next.start ? ` · ${examTime(next)}` : ''}{next.venue ? ` · ${next.venue}` : ''}</span>
        {sameDay.length > 0 && <span className="ex-next-meta">Same day: {sameDay.map(examTitle).join(', ')}</span>}
      </div>
      {season.length > 1 && (
        <div className="ex-next-season">
          <span>{done} of {season.length} papers done</span>
          <span className="ex-progress" aria-hidden="true"><i style={{ width: `${(done / season.length) * 100}%` }} /></span>
          {onPlan && <button className="linkish" onClick={onPlan}>Plan revision →</button>}
        </div>
      )}
    </div>
  )
}

function ExamChip({ e, today, schoolName, onOpen, showTime = true }: { e: Exam; today: string; schoolName: ((id: string) => string) | null; onOpen: (e: Exam) => void; showTime?: boolean }) {
  return (
    <button className={`ex-cal-chip ${subjectColor(e.subject)}${e.date < today ? ' past' : ''}`} onClick={() => onOpen(e)} title={`${examTitle(e)}${e.start ? ` · ${examTime(e)}` : ''}`}>
      {showTime && e.start && <span className="ex-cal-time">{formatTime(e.start).replace(':00', '').replace(' ', '').toLowerCase()}</span>}
      <span className="ex-cal-name">{examTitle(e)}</span>
      {schoolName && <span className="ex-cal-school">{schoolName(e.school)}</span>}
    </button>
  )
}

function ExamMonth({ exams, today, weekStartsMonday, schoolName, onOpen }: { exams: Exam[]; today: string; weekStartsMonday: boolean; schoolName: ((id: string) => string) | null; onOpen: (e: Exam) => void }) {
  // open on the month of the next exam (or this month)
  const first = exams.find((e) => e.date >= today)?.date || today
  const [month, setMonth] = useState(() => first.slice(0, 7))
  const [y, m] = month.split('-').map(Number)
  const start = new Date(y, m - 1, 1)
  const shift = (start.getDay() - (weekStartsMonday ? 1 : 0) + 7) % 7
  const gridStart = addDays(toKey(start), -shift)
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const weeks = days[35].slice(0, 7) === month ? 6 : 5
  const byDay = new Map<string, Exam[]>()
  for (const e of exams) byDay.set(e.date, [...(byDay.get(e.date) || []), e])
  const names = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + (weekStartsMonday ? 1 : 0)) % 7])
  const go = (n: number) => { const d = new Date(y, m - 1 + n, 1); setMonth(toKey(d).slice(0, 7)) }
  const count = exams.filter((e) => e.date.startsWith(month)).length
  return (
    <section className="ex-month card" aria-label={`${MONTHS[m - 1]} ${y}`}>
      <div className="ex-month-head">
        <button className="icon-btn" onClick={() => go(-1)} aria-label="Previous month"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
        <h3>{MONTHS[m - 1]} {y}</h3>
        <button className="icon-btn" onClick={() => go(1)} aria-label="Next month"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg></button>
        <span className="help ex-month-count">{count ? `${count} paper${count === 1 ? '' : 's'}` : 'No exams'}</span>
        {month !== today.slice(0, 7) && <button className="btn ghost sm" onClick={() => setMonth(today.slice(0, 7))}>Today</button>}
      </div>
      <div className="ex-grid" role="grid">
        {names.map((n) => <div key={n} className="ex-dow" role="columnheader">{n}</div>)}
        {days.slice(0, weeks * 7).map((k) => {
          const list = byDay.get(k) || []
          const out = !k.startsWith(month)
          return (
            <div key={k} role="gridcell" className={`ex-day${out ? ' out' : ''}${k === today ? ' today' : ''}${list.length ? ' has' : ''}${k < today ? ' past' : ''}`}>
              <span className="ex-day-n">{fromKey(k).getDate()}</span>
              {list.map((e) => <ExamChip key={e.id} e={e} today={today} schoolName={schoolName} onOpen={onOpen} />)}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ExamList({ exams, today, weekStartsMonday, schoolName, onOpen }: { exams: Exam[]; today: string; weekStartsMonday: boolean; schoolName: ((id: string) => string) | null; onOpen: (e: Exam) => void }) {
  const [showDone, setShowDone] = useState(false)
  const upcoming = exams.filter((e) => e.date >= today)
  const past = exams.filter((e) => e.date < today).reverse()
  const weekOf = (k: string) => { const d = fromKey(k); return addDays(k, -((d.getDay() - (weekStartsMonday ? 1 : 0) + 7) % 7)) }
  const thisWeek = weekOf(today)
  const weekTitle = (w: string) => {
    const n = daysBetween(thisWeek, w) / 7
    if (n === 0) return 'This week'
    if (n === 1) return 'Next week'
    const d = fromKey(w)
    return `Week of ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`
  }
  const weeks = [...new Set(upcoming.map((e) => weekOf(e.date)))]
  const row = (e: Exam) => {
    const dd = fromKey(e.date)
    const n = daysBetween(today, e.date)
    return (
      <li key={e.id}>
        <button className={`ex-row ${subjectColor(e.subject)}${e.date < today ? ' past' : ''}`} onClick={() => onOpen(e)}>
          <span className="ex-date" aria-hidden="true"><small>{WEEKDAYS[dd.getDay()]}</small><b>{dd.getDate()}</b><small>{MONTHS[dd.getMonth()].slice(0, 3)}</small></span>
          <span className="ex-row-body">
            <span className="ex-row-title">{examTitle(e)}{e.who && <span className="ex-who">{e.who}</span>}</span>
            <span className="ex-row-meta">
              {[examTime(e), lengthText(e.minutes), e.venue, schoolName ? schoolName(e.school) : ''].filter(Boolean).join(' · ') || 'Time to be confirmed'}
            </span>
          </span>
          <span className={`ex-when${n === 0 ? ' now' : n > 0 && n <= 3 ? ' soon' : ''}`}>{countdown(e.date, today)}</span>
        </button>
      </li>
    )
  }
  if (!exams.length) return <div className="ex-empty card"><p className="help">No exams on the timetable yet.</p></div>
  return (
    <div className="ex-list">
      {weeks.map((w) => (
        <section key={w} className="ex-week">
          <h3 className="group-title">{weekTitle(w)} <span className="count">{upcoming.filter((e) => weekOf(e.date) === w).length}</span></h3>
          <ul className="ex-rows card">{upcoming.filter((e) => weekOf(e.date) === w).map(row)}</ul>
        </section>
      ))}
      {!upcoming.length && <div className="ex-empty card"><p className="help">No more exams coming up.</p></div>}
      {past.length > 0 && (
        <section className="ex-week">
          <button className="group-title fold" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
            <svg className={`chev${showDone ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
            Done <span className="count">{past.length}</span>
          </button>
          {showDone && <ul className="ex-rows card">{past.map(row)}</ul>}
        </section>
      )}
    </div>
  )
}

function MyRequests({ requests, onWithdraw }: { requests: ExamRequest[]; onWithdraw: (id: string) => void }) {
  const label = { pending: 'Waiting', added: 'Added', declined: 'Not added' }
  return (
    <section className="ex-week">
      <h3 className="group-title">Your requests</h3>
      <ul className="ex-rows card">
        {requests.slice(0, 10).map((r) => (
          <li key={r.id} className="ex-reqrow">
            <span className="ex-row-body">
              <span className="ex-row-title">{examTitle(r)}</span>
              <span className="ex-row-meta">{longDate(r.date)}{r.start ? ` · ${examTime(r)}` : ''}{r.reason ? ` · “${r.reason}”` : ''}</span>
            </span>
            <span className={`ex-status ${r.status}`}>{label[r.status]}</span>
            {r.status === 'pending' && <button className="btn quiet sm" onClick={() => onWithdraw(r.id)}>Withdraw</button>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function ExamDetails({ exam: e, school, admin, today, onClose, onEdit, onDelete }: { exam: Exam; school: string; admin: boolean; today: string; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const rows: [string, ReactNode][] = [
    ['When', `${longDate(e.date)} · ${countdown(e.date, today)}`],
    ['Time', examTime(e) || 'To be confirmed'],
    ['Length', lengthText(e.minutes)],
    ['Venue', e.venue],
    ['For', e.who],
    ['School', school],
  ]
  return (
    <Dialog title={examTitle(e)} onClose={onClose} className={`ex-details ${subjectColor(e.subject)}`} closeButton>
      <dl className="ex-dl">
        {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {e.notes && <p className="ex-notes">{e.notes}</p>}
      {admin && (
        <div className="dialog-actions">
          <button className="btn danger sm" onClick={onDelete}>Delete</button>
          <span className="spacer" />
          <button className="btn sm" onClick={onEdit}>Edit</button>
        </div>
      )}
    </Dialog>
  )
}

const LENGTHS = [30, 45, 60, 75, 90, 105, 110, 120, 135, 150, 165, 180, 210, 240]

function ExamForm({ initial, schools, school, subjects, mode, onClose, onSave }: {
  initial?: Partial<Exam>; schools: School[]; school: string; subjects: string[]
  mode: 'add' | 'edit' | 'request' | 'approve'; onClose: () => void; onSave: (b: ExamInput) => void
}) {
  const [v, setV] = useState<ExamInput>(() => ({
    school, subject: initial?.subject || '', paper: initial?.paper || '', date: initial?.date || '', start: initial?.start || '',
    minutes: initial?.minutes ?? null, venue: initial?.venue || '', who: initial?.who || '', notes: initial?.notes || '',
  }))
  const set = (p: ExamInput) => setV((x) => ({ ...x, ...p }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!v.subject?.trim()) return toast('Which subject?')
    if (!v.date) return toast('Pick a date')
    onSave({ ...v, start: v.start || null, minutes: v.minutes || null })
  }
  const title = { add: 'Add an exam', edit: 'Edit exam', request: 'Request an exam', approve: 'Add requested exam' }[mode]
  const lengths = v.minutes && !LENGTHS.includes(v.minutes) ? [...LENGTHS, v.minutes].sort((a, b) => a - b) : LENGTHS
  return (
    <Dialog title={title} onClose={onClose} className="ex-form" closeButton>
      <form onSubmit={submit}>
        {mode === 'request' && <p className="help ex-form-lead">Your admin checks it before it goes on everyone’s timetable.</p>}
        {mode !== 'request' && schools.length > 1 && (
          <label className="field"><span>School</span>
            <Select className="input" value={v.school || ''} onChange={(e) => set({ school: e.target.value })}>
              {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
        )}
        <div className="ex-form-row">
          <label className="field"><span>Subject</span>
            <input className="input" list="ex-subject-list" value={v.subject || ''} onChange={(e) => set({ subject: e.target.value })} placeholder="Chemistry" maxLength={40} autoFocus={mode !== 'approve'} />
            <datalist id="ex-subject-list">{subjects.map((s) => <option key={s} value={s} />)}</datalist>
          </label>
          <label className="field"><span>Paper</span>
            <input className="input" value={v.paper || ''} onChange={(e) => set({ paper: e.target.value })} placeholder="Paper 2" maxLength={40} />
          </label>
        </div>
        <div className="ex-form-row three">
          <label className="field"><span>Date</span><input className="input" type="date" value={v.date || ''} onChange={(e) => set({ date: e.target.value })} /></label>
          <label className="field"><span>Starts</span><input className="input" type="time" value={v.start || ''} onChange={(e) => set({ start: e.target.value })} /></label>
          <label className="field"><span>Length</span>
            <Select className="input" value={String(v.minutes || '')} onChange={(e) => set({ minutes: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Not sure</option>
              {lengths.map((m) => <option key={m} value={String(m)}>{lengthText(m)}</option>)}
            </Select>
          </label>
        </div>
        <div className="ex-form-row">
          <label className="field"><span>Venue</span><input className="input" value={v.venue || ''} onChange={(e) => set({ venue: e.target.value })} placeholder="Hall" maxLength={60} /></label>
          {mode !== 'request' && <label className="field"><span>For</span><input className="input" value={v.who || ''} onChange={(e) => set({ who: e.target.value })} placeholder="Sec 4 (optional)" maxLength={30} /></label>}
        </div>
        <label className="field"><span>Notes</span><textarea className="input" rows={2} value={v.notes || ''} onChange={(e) => set({ notes: e.target.value })} placeholder={mode === 'request' ? 'Where you heard about it, topics…' : 'Topics, what to bring…'} maxLength={600} /></label>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">{mode === 'request' ? 'Send request' : mode === 'edit' ? 'Save' : 'Add exam'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function RequestsDialog({ requests, schoolName, onClose, onAdd, onEdit, onDecline }: {
  requests: ExamRequest[]; schoolName: (id: string) => string; onClose: () => void
  onAdd: (r: ExamRequest) => void; onEdit: (r: ExamRequest) => void; onDecline: (r: ExamRequest) => void
}) {
  return (
    <Dialog title="Exam requests" onClose={onClose} className="ex-requests" closeButton>
      {!requests.length ? <p className="help">Nothing waiting.</p> : (
        <ul className="ex-req-list">
          {requests.map((r) => (
            <li key={r.id}>
              <div className="ex-req-main">
                <b>{examTitle(r)}</b>
                <span className="help">{longDate(r.date)}{r.start ? ` · ${examTime(r)}` : ''}{r.venue ? ` · ${r.venue}` : ''}</span>
                <span className="help">From {r.byName || r.by}{schoolName(r.school) ? ` · ${schoolName(r.school)}` : ''}</span>
                {r.notes && <span className="ex-req-notes">“{r.notes}”</span>}
              </div>
              <div className="ex-req-actions">
                <button className="btn sm" onClick={() => onAdd(r)}>Add</button>
                <button className="btn ghost sm" onClick={() => onEdit(r)}>Edit first</button>
                <button className="btn quiet sm" onClick={() => onDecline(r)}>Decline</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function SchoolsDialog({ schools, api: x, onClose }: { schools: School[]; api: ExamsApi; onClose: () => void }) {
  const [name, setName] = useState('')
  const [people, setPeople] = useState<{ username: string; name: string; school: string | null }[] | null>(null)
  const loadPeople = () => x.schoolPeople().then(setPeople).catch(() => setPeople([]))
  useEffect(() => { loadPeople() }, [schools.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (e: FormEvent) => { e.preventDefault(); if (name.trim() && (await x.addSchool(name.trim()))) setName('') }
  return (
    <Dialog title="Schools" onClose={onClose} className="ex-schools" closeButton>
      <ul className="ex-school-list">
        {schools.map((s) => (
          <li key={s.id}>
            <input className="input sm" defaultValue={s.name} aria-label="School name" maxLength={60}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) x.updateSchool(s.id, { name: v }) }} />
            <span className="help">{s.people || 0} {s.people === 1 ? 'person' : 'people'}</span>
            <button className="btn quiet sm" onClick={() => { if (confirm(`Delete ${s.name} and all its exams? Its people will need to pick a school again.`)) x.deleteSchool(s.id) }}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="row ex-school-add" onSubmit={add}>
        <input className="input sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="New school" maxLength={60} aria-label="New school" />
        <button className="btn sm" disabled={!name.trim()}>Add</button>
      </form>
      {schools.length > 0 && (
        <>
          <h3 className="ex-sub-title">Who’s where</h3>
          <p className="help">People can pick their school themselves too.</p>
          <ul className="ex-people">
            {(people || []).map((p) => (
              <li key={p.username}>
                <span>{p.name}</span>
                <Select className="input sm" value={p.school || ''} onChange={async (e) => { await x.setSchoolOf(p.username, e.target.value || null); loadPeople() }} aria-label={`${p.name}’s school`}>
                  <option value="">No school</option>
                  {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  )
}
