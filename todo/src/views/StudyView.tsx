import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { addDays, daysBetween, formatTime, fromKey, MONTHS, todayKey, WEEKDAYS } from '../dates'
import { Dialog } from '../components/Dialogs'
import { Popover } from '../components/Popover'
import { Select } from '../components/Select'
import { toast } from '../components/Toast'
import type { ColorName, Exam, StudyBlock, StudyMode, StudyPlan, StudySubject } from '../types'
import type { StudyApi } from '../useStudy'
import { examTitle, subjectColor } from './ExamsView'

/**
 * The study planner. Built like a revision timetable on a spreadsheet: one column
 * per day, the tests happening that day on top, and underneath what you'll study:
 * a subject, how (RE = revise/memorise, P = practice), and its topics, struck
 * through as you finish them. Exam days are purple, late days yellow, rest days
 * green; priority subjects are in red.
 */

const COLORS: ColorName[] = ['blue', 'orange', 'aqua', 'magenta', 'green', 'violet', 'yellow', 'none']
const MODES: { v: StudyMode; label: string; help: string }[] = [
  { v: '', label: '—', help: 'No particular way' },
  { v: 'RE', label: 'RE', help: 'Revise / memorise' },
  { v: 'P', label: 'P', help: 'Practice questions' },
  { v: 'RE+P', label: 'RE+P', help: 'Both' },
]
const rid = () => Math.random().toString(36).slice(2, 10)
const short = (k: string) => { const d = fromKey(k); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}` }
const colorOfSubject = (name: string) => subjectColor(name).slice(2) as ColorName
const weekStart = (k: string, monday: boolean) => addDays(k, -((fromKey(k).getDay() - (monday ? 1 : 0) + 7) % 7))
const blockDone = (b: StudyBlock) => (b.topics.length ? b.topics.every((t) => t.done) : b.done)

export function StudyView({ study, exams, weekStartsMonday, onExams }: { study: StudyApi; exams: Exam[]; weekStartsMonday: boolean; onExams: () => void }) {
  const { plan, change } = study
  const today = todayKey()
  const phone = typeof window !== 'undefined' && window.innerWidth < 760
  const [span, setSpan] = useState<7 | 14>(() => { try { return localStorage.getItem('todo-study-span') === '7' || phone ? 7 : 14 } catch { return 14 } })
  const [start, setStart] = useState(() => weekStart(today, weekStartsMonday))
  const [edit, setEdit] = useState<{ block?: StudyBlock; date: string } | null>(null)
  const [subjectsOpen, setSubjectsOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [menu, setMenu] = useState<{ date: string; anchor: HTMLElement } | null>(null)
  const [adding, setAdding] = useState<string | null>(null) // a day getting a new test typed in
  const board = useRef<HTMLDivElement>(null)
  const drag = useRef<string | null>(null) // the block being dragged
  useEffect(() => { try { localStorage.setItem('todo-study-span', String(span)) } catch {} }, [span])

  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(start, i)), [start, span])
  // bring today into view if it's off to the right (phones show about one day at a time)
  useEffect(() => {
    const box = board.current
    const el = box?.querySelector<HTMLElement>('.sp-head.today')
    if (!box || !el) { if (box) box.scrollLeft = 0; return }
    const labels = box.querySelector<HTMLElement>('.sp-corner')?.offsetWidth || 0 // the sticky row labels
    const left = el.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft
    box.scrollLeft = left + el.offsetWidth > box.clientWidth ? left - labels : 0
  }, [start, span, plan === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const examsByDay = useMemo(() => {
    const m = new Map<string, Exam[]>()
    for (const e of exams) m.set(e.date, [...(m.get(e.date) || []), e])
    return m
  }, [exams])
  if (!plan) return <div className="sp-page" aria-busy="true" />

  const subj = (id: string) => plan.subjects.find((s) => s.id === id)
  const blocksOn = (k: string) => plan.blocks.filter((b) => b.date === k).sort((a, b) => a.order - b.order)
  const nextExamAfter = (k: string) => exams.find((e) => e.date > k)

  // ---- changes
  const setBlock = (id: string, fn: (b: StudyBlock) => StudyBlock) => change((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === id ? fn(b) : b)) }))
  const toggleTopic = (b: StudyBlock, tid: string) => setBlock(b.id, (x) => ({ ...x, topics: x.topics.map((t) => (t.id === tid ? { ...t, done: !t.done } : t)) }))
  const setDay = (k: string, kind: 'rest' | 'late' | null) => change((p) => {
    const days = { ...p.days }
    if (kind) days[k] = kind
    else delete days[k]
    return { ...p, days }
  })
  const moveBlock = (id: string, to: string) => change((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, date: to, order: Date.now() } : b)) }))
  /** Unfinished work on a day goes to the next day you're studying. */
  const pushOn = (k: string) => {
    let to = addDays(k, 1)
    for (let i = 0; i < 14 && plan.days[to] === 'rest'; i++) to = addDays(to, 1)
    const left = blocksOn(k).filter((b) => !blockDone(b))
    if (!left.length) return toast('Nothing unfinished that day')
    change((p) => ({
      ...p,
      blocks: p.blocks.flatMap((b) => {
        if (b.date !== k || blockDone(b)) return [b]
        const done = b.topics.filter((t) => t.done)
        const moved = { ...b, id: done.length ? rid() : b.id, date: to, topics: b.topics.filter((t) => !t.done), order: Date.now() }
        // ticked topics stay where you did them
        return done.length ? [{ ...b, topics: done }, moved] : [moved]
      }),
    }))
    toast(`Moved ${left.length} to ${short(to)}`)
  }
  const addTest = (k: string, title: string) => {
    if (!title.trim()) return
    change((p) => ({ ...p, tests: [...p.tests, { id: rid(), date: k, title: title.trim().slice(0, 80), note: '' }] }))
  }

  // ---- drag a block to another day (mouse; on phones, use "Day" in its editor)
  const onDrop = (k: string) => (e: DragEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).classList.remove('drop')
    const id = drag.current || e.dataTransfer.getData('text/plain')
    if (id) moveBlock(id, k)
    drag.current = null
  }

  // ---- this stretch, in numbers
  const inRange = plan.blocks.filter((b) => b.date >= days[0] && b.date <= days[days.length - 1])
  const topics = inRange.flatMap((b) => (b.topics.length ? b.topics : [{ done: b.done }]))
  const doneN = topics.filter((t) => t.done).length

  const label = `${short(days[0])} – ${short(days[days.length - 1])}`
  const legend = (
    <div className="sp-legend" aria-label="Key">
      <span className="sp-key exam">Exam day</span>
      <span className="sp-key late">Late day</span>
      <span className="sp-key rest">Rest day</span>
      <span className="sp-key"><b>RE</b> revise / memorise</span>
      <span className="sp-key"><b>P</b> practice</span>
      <span className="sp-key prio">Priority subject</span>
    </div>
  )

  return (
    <div className="sp-page">
      <div className="sp-bar">
        <div className="sp-nav">
          <button className="icon-btn" onClick={() => setStart(addDays(start, -7))} aria-label="Earlier"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
          <button className="btn ghost sm" onClick={() => setStart(weekStart(today, weekStartsMonday))}>Today</button>
          <button className="icon-btn" onClick={() => setStart(addDays(start, 7))} aria-label="Later"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg></button>
          <h3 className="sp-range">{label}</h3>
        </div>
        <div className="seg sm" role="radiogroup" aria-label="How many days">
          <button role="radio" aria-checked={span === 7} className={span === 7 ? 'on' : ''} onClick={() => setSpan(7)}>1 week</button>
          <button role="radio" aria-checked={span === 14} className={span === 14 ? 'on' : ''} onClick={() => setSpan(14)}>2 weeks</button>
        </div>
        <span className="spacer" />
        {topics.length > 0 && <span className="sp-done" title="Topics ticked off in these days">{doneN}/{topics.length} done</span>}
        <button className="btn ghost sm" onClick={() => setSubjectsOpen(true)}>Subjects</button>
        <button className="btn sm" onClick={() => setPlanOpen(true)}>Plan from exams</button>
      </div>
      {legend}

      {!plan.subjects.length && (
        <div className="sp-start card">
          <b>Start with your subjects</b>
          <p className="help">Then add what you’ll study each day, or let the planner fill in revision before your exams.</p>
          <div className="row">
            <button className="btn sm" onClick={() => setSubjectsOpen(true)}>Add subjects</button>
            {!exams.length && <button className="btn ghost sm" onClick={onExams}>Set up your exams</button>}
          </div>
        </div>
      )}

      <div className="sp-scroll" ref={board}>
        <div className="sp-board" style={{ ['--days' as string]: span }}>
          <div className="sp-corner" />
          {days.map((k) => {
            const dd = fromKey(k)
            const exam = examsByDay.has(k)
            const kind = plan.days[k]
            const next = nextExamAfter(k)
            const until = next ? daysBetween(k, next.date) : 99
            return (
              <div key={k} className={`sp-head${exam ? ' exam' : ''}${kind ? ` ${kind}` : ''}${k === today ? ' today' : ''}${k < today ? ' past' : ''}`}>
                <span className="sp-dow">{WEEKDAYS[dd.getDay()]}</span>
                <span className="sp-date">{dd.getDate()} {MONTHS[dd.getMonth()].slice(0, 3)}</span>
                <span className="sp-tag">{exam ? 'Exam day' : kind === 'rest' ? 'Rest day' : kind === 'late' ? 'Late day' : until <= 14 && next ? `${until}d to ${next.subject}` : ''}</span>
                <button className="icon-btn sm sp-daybtn" aria-label={`${WEEKDAYS[dd.getDay()]} ${short(k)} options`} onClick={(e) => setMenu({ date: k, anchor: e.currentTarget })}>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.3" /><circle cx="10" cy="10" r="1.3" /><circle cx="15" cy="10" r="1.3" /></svg>
                </button>
              </div>
            )
          })}

          <div className="sp-rowhead">Tests<small>happening + criteria</small></div>
          {days.map((k) => (
            <div key={k} className={`sp-cell sp-tests${plan.days[k] ? ` ${plan.days[k]}` : ''}${k === today ? ' today' : ''}`}>
              <span className="sp-cap">Tests</span>
              {(examsByDay.get(k) || []).map((e) => (
                <span key={e.id} className={`sp-exam ${subjectColor(e.subject)}`} title="From the Exams page">
                  <b>{examTitle(e)}</b>{e.start && <small>{formatTime(e.start)}</small>}
                </span>
              ))}
              {plan.tests.filter((t) => t.date === k).map((t) => (
                <span key={t.id} className="sp-test">
                  {t.title}
                  <button className="sp-x" aria-label={`Remove ${t.title}`} onClick={() => change((p) => ({ ...p, tests: p.tests.filter((x) => x.id !== t.id) }))}>×</button>
                </span>
              ))}
              {adding === k ? (
                <form onSubmit={(e) => { e.preventDefault(); const i = (e.currentTarget.elements[0] as HTMLInputElement); addTest(k, i.value); setAdding(null) }}>
                  <input className="input sm sp-test-input" autoFocus placeholder="e.g. Biology AFR" maxLength={80} onBlur={(e) => { addTest(k, e.target.value); setAdding(null) }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(null) } }} />
                </form>
              ) : (
                <button className="sp-add sm" onClick={() => setAdding(k)}>+ Test</button>
              )}
            </div>
          ))}

          <div className="sp-rowhead">Study<small>of the day</small></div>
          {days.map((k) => (
            <div
              key={k}
              className={`sp-cell sp-study${plan.days[k] ? ` ${plan.days[k]}` : ''}${k === today ? ' today' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drop') }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drop')}
              onDrop={onDrop(k)}
            >
              <span className="sp-cap">Study</span>
              {plan.days[k] === 'rest' && !blocksOn(k).length && <span className="sp-rest">Rest 🌿</span>}
              {blocksOn(k).map((b) => {
                const s = subj(b.subject)
                const done = blockDone(b)
                return (
                  <div
                    key={b.id}
                    className={`sp-block c-${s?.color || 'none'}${done ? ' done' : ''}`}
                    draggable
                    onDragStart={(e) => { drag.current = b.id; e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move' }}
                  >
                    <button className="sp-block-head" onClick={() => setEdit({ block: b, date: k })} title="Edit">
                      <span className={`sp-subject${s?.priority ? ' prio' : ''}`}>{s?.name || 'Subject'}</span>
                      {b.mode && <span className="sp-mode">{b.mode}</span>}
                    </button>
                    {b.topics.length ? (
                      <ul className="sp-topics">
                        {b.topics.map((t) => (
                          <li key={t.id}>
                            <button className={t.done ? 'done' : ''} onClick={() => toggleTopic(b, t.id)} aria-pressed={t.done}>{t.text}</button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <button className={`sp-whole${b.done ? ' done' : ''}`} onClick={() => setBlock(b.id, (x) => ({ ...x, done: !x.done }))} aria-pressed={b.done}>{b.done ? '✓ Done' : '○ Mark done'}</button>
                    )}
                    {b.note && <p className="sp-note">{b.note}</p>}
                  </div>
                )
              })}
              <button className="sp-add" onClick={() => (plan.subjects.length ? setEdit({ date: k }) : setSubjectsOpen(true))}>+ Add</button>
            </div>
          ))}
        </div>
      </div>

      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} label="Day" width={210}>
          <div className="menu">
            {([[null, 'Normal day'], ['late', 'Late day'], ['rest', 'Rest day']] as const).map(([v, l]) => (
              <button key={l} className={`menu-item${(plan.days[menu.date] || null) === v ? ' on' : ''}`} onClick={() => { setDay(menu.date, v); setMenu(null) }}>
                <span className={`sp-dot ${v || 'normal'}`} aria-hidden="true" />{l}
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { pushOn(menu.date); setMenu(null) }}>Move unfinished to next day</button>
            <button className="menu-item" onClick={() => { if (plan.subjects.length) setEdit({ date: menu.date }); else setSubjectsOpen(true); setMenu(null) }}>Add study…</button>
          </div>
        </Popover>
      )}
      {edit && (
        <BlockDialog
          plan={plan}
          block={edit.block}
          date={edit.date}
          onClose={() => setEdit(null)}
          onSave={(b, newSubject) => {
            change((p) => {
              const subjects = newSubject ? [...p.subjects, newSubject] : p.subjects
              const exists = p.blocks.some((x) => x.id === b.id)
              return { ...p, subjects, blocks: exists ? p.blocks.map((x) => (x.id === b.id ? b : x)) : [...p.blocks, b] }
            })
            setEdit(null)
          }}
          onDelete={edit.block ? () => { change((p) => ({ ...p, blocks: p.blocks.filter((x) => x.id !== edit.block!.id) })); setEdit(null) } : undefined}
        />
      )}
      {subjectsOpen && <SubjectsDialog plan={plan} examSubjects={[...new Set(exams.map((e) => e.subject))]} onChange={change} onClose={() => setSubjectsOpen(false)} />}
      {planOpen && <PlanDialog plan={plan} exams={exams.filter((e) => e.date > today)} today={today} onChange={change} onClose={() => setPlanOpen(false)} onExams={onExams} />}
    </div>
  )
}

// ------------------------------------------------------------- dialogs
function BlockDialog({ plan, block, date, onClose, onSave, onDelete }: {
  plan: StudyPlan; block?: StudyBlock; date: string; onClose: () => void
  onSave: (b: StudyBlock, newSubject?: StudySubject) => void; onDelete?: () => void
}) {
  const [subject, setSubject] = useState(block?.subject || plan.subjects[0]?.id || '')
  const [newName, setNewName] = useState('')
  const [mode, setMode] = useState<StudyMode>(block?.mode ?? 'RE')
  const [text, setText] = useState((block?.topics || []).map((t) => t.text).join('\n'))
  const [note, setNote] = useState(block?.note || '')
  const [day, setDay] = useState(block?.date || date)
  const creating = subject === '__new'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    let sid = subject
    let made: StudySubject | undefined
    if (creating) {
      const name = newName.trim()
      if (!name) return toast('Name the subject')
      const same = plan.subjects.find((s) => s.name.toLowerCase() === name.toLowerCase())
      if (same) sid = same.id
      else { made = { id: rid(), name, color: colorOfSubject(name), priority: false }; sid = made.id }
    }
    if (!sid) return toast('Pick a subject')
    // keep ticks on topics that are still there
    const old = new Map((block?.topics || []).map((t) => [t.text, t]))
    const topics = text.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 40).map((x) => old.get(x) || { id: rid(), text: x.slice(0, 120), done: false })
    onSave({ id: block?.id || rid(), date: day || date, subject: sid, mode, topics, note: note.trim(), done: block?.done || false, order: block?.order ?? Date.now() }, made)
  }
  return (
    <Dialog title={block ? 'Edit study' : `Study on ${WEEKDAYS[fromKey(date).getDay()]} ${short(date)}`} onClose={onClose} className="sp-dialog" closeButton>
      <form onSubmit={submit}>
        <label className="field"><span>Subject</span>
          <Select className="input" value={subject} onChange={(e) => setSubject(e.target.value)}>
            {plan.subjects.map((s) => <option key={s.id} value={s.id}>{s.priority ? `${s.name} (priority)` : s.name}</option>)}
            <option value="__new">+ New subject…</option>
          </Select>
        </label>
        {creating && <label className="field"><span>New subject</span><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} autoFocus placeholder="Additional Mathematics" /></label>}
        <div className="field"><span className="label">How</span>
          <div className="seg" role="radiogroup" aria-label="How">
            {MODES.map((m) => <button key={m.v || 'none'} type="button" role="radio" aria-checked={mode === m.v} className={mode === m.v ? 'on' : ''} title={m.help} onClick={() => setMode(m.v)}>{m.label}</button>)}
          </div>
          <span className="help">{MODES.find((m) => m.v === mode)?.help}</span>
        </div>
        <label className="field"><span>Topics</span>
          <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'One per line\nRedox chemistry\nRate of reactions'} />
        </label>
        <div className="sp-form-row">
          <label className="field"><span>Day</span><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
          <label className="field"><span>Note</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Section B, essay…" /></label>
        </div>
        <div className="dialog-actions">
          {onDelete && <button type="button" className="btn danger" onClick={onDelete}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">{block ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function SubjectsDialog({ plan, examSubjects, onChange, onClose }: { plan: StudyPlan; examSubjects: string[]; onChange: StudyApi['change']; onClose: () => void }) {
  const [name, setName] = useState('')
  const missing = examSubjects.filter((x) => !plan.subjects.some((s) => s.name.toLowerCase() === x.toLowerCase()))
  const set = (id: string, patch: Partial<StudySubject>) => onChange((p) => ({ ...p, subjects: p.subjects.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))
  const add = (names: string[]) => onChange((p) => ({ ...p, subjects: [...p.subjects, ...names.map((n) => ({ id: rid(), name: n.slice(0, 40), color: colorOfSubject(n), priority: false }))] }))
  const remove = (s: StudySubject) => {
    const n = plan.blocks.filter((b) => b.subject === s.id).length
    if (n && !confirm(`Delete ${s.name} and its ${n} study block${n === 1 ? '' : 's'}?`)) return
    onChange((p) => ({ ...p, subjects: p.subjects.filter((x) => x.id !== s.id), blocks: p.blocks.filter((b) => b.subject !== s.id) }))
  }
  return (
    <Dialog title="Subjects" onClose={onClose} className="sp-subjects" closeButton>
      <p className="help">Priority subjects show in red, like on a revision sheet.</p>
      <ul className="sp-subject-list">
        {plan.subjects.map((s) => {
          const blocks = plan.blocks.filter((b) => b.subject === s.id)
          const ts = blocks.flatMap((b) => b.topics)
          return (
            <li key={s.id}>
              <button className={`sp-color c-${s.color}`} aria-label={`Colour of ${s.name}`} title="Change colour"
                onClick={() => set(s.id, { color: COLORS[(COLORS.indexOf(s.color) + 1) % COLORS.length] })} />
              <input className={`input sm${s.priority ? ' prio' : ''}`} defaultValue={s.name} maxLength={40} aria-label="Subject name"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) set(s.id, { name: v }) }} />
              <button className={`btn sm sp-prio${s.priority ? ' on' : ''}`} aria-pressed={s.priority} onClick={() => set(s.id, { priority: !s.priority })}>{s.priority ? '★ Priority' : '☆ Priority'}</button>
              <span className="help sp-subject-n">{ts.length ? `${ts.filter((t) => t.done).length}/${ts.length}` : blocks.length || ''}</span>
              <button className="icon-btn sm" aria-label={`Delete ${s.name}`} onClick={() => remove(s)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg></button>
            </li>
          )
        })}
      </ul>
      <form className="row sp-subject-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { add([name.trim()]); setName('') } }}>
        <input className="input sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a subject" maxLength={40} aria-label="New subject" />
        <button className="btn sm" disabled={!name.trim()}>Add</button>
      </form>
      {missing.length > 0 && <button className="btn ghost sm sp-from-exams" onClick={() => add(missing)}>Add from my exams ({missing.join(', ')})</button>}
    </Dialog>
  )
}

/** Revision before each exam: revise a week before, practise three days before, both the day before. */
const STEPS: { before: number; mode: StudyMode; label: string }[] = [
  { before: 7, mode: 'RE', label: 'A week before: revise' },
  { before: 3, mode: 'P', label: '3 days before: practice' },
  { before: 1, mode: 'RE+P', label: 'The day before: both' },
]

function PlanDialog({ plan, exams, today, onChange, onClose, onExams }: { plan: StudyPlan; exams: Exam[]; today: string; onChange: StudyApi['change']; onClose: () => void; onExams: () => void }) {
  const soon = exams.filter((e) => daysBetween(today, e.date) <= 60)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(soon.map((e) => e.id)))
  const [steps, setSteps] = useState<Set<number>>(() => new Set(STEPS.map((s) => s.before)))
  const examDays = new Set(exams.map((e) => e.date))

  const build = () => {
    const subjects = [...plan.subjects]
    const blocks: StudyBlock[] = []
    const has = (date: string, sid: string) => [...plan.blocks, ...blocks].some((b) => b.date === date && b.subject === sid)
    for (const e of soon.filter((x) => picked.has(x.id))) {
      let s = subjects.find((x) => x.name.toLowerCase() === e.subject.toLowerCase())
      if (!s) { s = { id: rid(), name: e.subject, color: colorOfSubject(e.subject), priority: false }; subjects.push(s) }
      for (const st of STEPS.filter((x) => steps.has(x.before))) {
        let day = addDays(e.date, -st.before)
        // not on a rest day or another exam day: go a day earlier (but never into the past)
        for (let i = 0; i < 3 && (plan.days[day] === 'rest' || examDays.has(day)); i++) day = addDays(day, -1)
        if (day < today || has(day, s.id)) continue
        blocks.push({ id: rid(), date: day, subject: s.id, mode: st.mode, topics: [], note: `For ${examTitle(e)} on ${short(e.date)}`, done: false, order: Date.now() + blocks.length })
      }
    }
    return { subjects, blocks }
  }
  const preview = build()
  return (
    <Dialog title="Plan from exams" onClose={onClose} className="sp-plan" closeButton>
      {!soon.length ? (
        <>
          <p className="help">No exams in the next two months. They come from the Exams page, for your school and subjects.</p>
          <div className="dialog-actions"><span className="spacer" /><button className="btn" onClick={() => { onClose(); onExams() }}>Go to Exams</button></div>
        </>
      ) : (
        <>
          <p className="help">Adds study blocks before each exam. Rest days and other exam days are skipped. You can change anything afterwards.</p>
          <div className="sp-steps">
            {STEPS.map((st) => (
              <label key={st.before} className="toggle tight">
                <input type="checkbox" checked={steps.has(st.before)} onChange={() => setSteps((x) => { const n = new Set(x); if (n.has(st.before)) n.delete(st.before); else n.add(st.before); return n })} />
                <span>{st.label} <small>({st.mode})</small></span>
              </label>
            ))}
          </div>
          <ul className="sp-plan-list">
            {soon.map((e) => (
              <li key={e.id}>
                <label className="toggle tight">
                  <input type="checkbox" checked={picked.has(e.id)} onChange={() => setPicked((x) => { const n = new Set(x); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n })} />
                  <span><i className={`swatch ${subjectColor(e.subject)}`} aria-hidden="true" /> {examTitle(e)} <small>{WEEKDAYS[fromKey(e.date).getDay()]} {short(e.date)}</small></span>
                </label>
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <span className="help">{preview.blocks.length ? `Adds ${preview.blocks.length} study block${preview.blocks.length === 1 ? '' : 's'}` : 'Nothing new to add'}</span>
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={!preview.blocks.length} onClick={() => {
              const n = preview.blocks.length
              onChange((p) => ({ ...p, subjects: preview.subjects, blocks: [...p.blocks, ...preview.blocks] }))
              toast(`Added ${n} study block${n === 1 ? '' : 's'}`)
              onClose()
            }}>Add to planner</button>
          </div>
        </>
      )}
    </Dialog>
  )
}
