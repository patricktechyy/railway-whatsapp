import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { addDays, daysBetween, formatTime, fromKey, MONTHS, todayKey, WEEKDAYS } from '../dates'
import { Dialog } from '../components/Dialogs'
import { Popover } from '../components/Popover'
import { Select } from '../components/Select'
import { toast } from '../components/Toast'
import { chime } from '../sound'
import type { ColorName, Exam, StudyBlock, StudyMode, StudyPlan, StudySubject, StudyTag } from '../types'
import type { StudyApi } from '../useStudy'
import { examTitle, subjectColor } from './ExamsView'

/**
 * The study planner. Built like a revision timetable on a spreadsheet: one column
 * per day, the tests happening that day on top, and underneath what you'll study:
 * a subject, how (RE = revise/memorise, P = practice), and its topics, struck
 * through as you finish them. Exam days are purple, late days yellow, rest days
 * green; priority subjects are in red.
 *
 * On top of the sheet: your own tags, a time and length per block (Buddy nudges you
 * on WhatsApp then), a focus timer that logs what you actually did, filters, and a
 * progress summary.
 */

const COLORS: ColorName[] = ['blue', 'orange', 'aqua', 'magenta', 'green', 'violet', 'yellow', 'none']
const MODES: { v: StudyMode; label: string; help: string }[] = [
  { v: '', label: '—', help: 'No particular way' },
  { v: 'RE', label: 'RE', help: 'Revise / memorise' },
  { v: 'P', label: 'P', help: 'Practice questions' },
  { v: 'RE+P', label: 'RE+P', help: 'Both' },
]
const NEXT_MODE: Record<StudyMode, StudyMode> = { '': 'RE', RE: 'P', P: 'RE+P', 'RE+P': '' }
const LENGTHS = [15, 20, 25, 30, 45, 60, 75, 90, 120, 150, 180]
const rid = () => Math.random().toString(36).slice(2, 10)
const short = (k: string) => { const d = fromKey(k); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}` }
const colorOfSubject = (name: string) => subjectColor(name).slice(2) as ColorName
const weekStart = (k: string, monday: boolean) => addDays(k, -((fromKey(k).getDay() - (monday ? 1 : 0) + 7) % 7))
const blockDone = (b: StudyBlock) => (b.topics.length ? b.topics.every((t) => t.done) : b.done)
const fmtMin = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`)
const byTime = (a: StudyBlock, b: StudyBlock) => (a.time || '99').localeCompare(b.time || '99') || a.order - b.order

/** What the filter chips can pick: a way of studying, priority subjects, a subject or a tag. */
type Filter = { kind: 'mode' | 'prio' | 'subject' | 'tag'; id: string } | null
/** The focus timer (kept on this device, so it survives a refresh). */
type Focus = { id: string; minutes: number; start: number; paused: number | null; idle: number }
const FOCUS_KEY = 'todo-focus'

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
  const [topicFor, setTopicFor] = useState<string | null>(null) // a block getting a new topic typed in
  const [filter, setFilter] = useState<Filter>(null)
  const [focus, setFocus] = useState<Focus | null>(() => { try { return JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null') } catch { return null } })
  const board = useRef<HTMLDivElement>(null)
  const drag = useRef<string | null>(null) // the block being dragged
  useEffect(() => { try { localStorage.setItem('todo-study-span', String(span)) } catch {} }, [span])
  useEffect(() => { try { focus ? localStorage.setItem(FOCUS_KEY, JSON.stringify(focus)) : localStorage.removeItem(FOCUS_KEY) } catch {} }, [focus])

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

  // the block being timed was deleted (here or on another device): drop the timer
  useEffect(() => { if (plan && focus && !plan.blocks.some((b) => b.id === focus.id)) setFocus(null) }, [plan, focus])

  const examsByDay = useMemo(() => {
    const m = new Map<string, Exam[]>()
    for (const e of exams) m.set(e.date, [...(m.get(e.date) || []), e])
    return m
  }, [exams])
  if (!plan) return <div className="sp-page" aria-busy="true" />

  const tags = plan.tags || []
  const subj = (id: string) => plan.subjects.find((s) => s.id === id)
  const blocksOn = (k: string) => plan.blocks.filter((b) => b.date === k).sort(byTime)
  const nextExamAfter = (k: string) => exams.find((e) => e.date > k)
  const matches = (b: StudyBlock) => {
    if (!filter) return true
    if (filter.kind === 'mode') return b.mode.includes(filter.id)
    if (filter.kind === 'prio') return !!subj(b.subject)?.priority
    if (filter.kind === 'subject') return b.subject === filter.id
    return (b.tags || []).includes(filter.id)
  }
  const pick = (f: NonNullable<Filter>) => setFilter((cur) => (cur && cur.kind === f.kind && cur.id === f.id ? null : f))
  const picked = (kind: NonNullable<Filter>['kind'], id: string) => !!filter && filter.kind === kind && filter.id === id

  // ---- changes
  const setBlock = (id: string, fn: (b: StudyBlock) => StudyBlock) => change((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === id ? fn(b) : b)) }))
  const toggleTopic = (b: StudyBlock, tid: string) => setBlock(b.id, (x) => ({ ...x, topics: x.topics.map((t) => (t.id === tid ? { ...t, done: !t.done } : t)) }))
  const addTopic = (b: StudyBlock, text: string) => {
    const t = text.trim().slice(0, 120)
    if (t) setBlock(b.id, (x) => ({ ...x, topics: [...x.topics, { id: rid(), text: t, done: false }] }))
  }
  const setDay = (k: string, kind: 'rest' | 'late' | null) => change((p) => {
    const days = { ...p.days }
    if (kind) days[k] = kind
    else delete days[k]
    return { ...p, days }
  })
  const moveBlock = (id: string, to: string) => change((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, date: to, order: Date.now() } : b)) }))
  const removeBlock = (b: StudyBlock) => {
    change((p) => ({ ...p, blocks: p.blocks.filter((x) => x.id !== b.id) }))
    toast('Study block deleted', { label: 'Undo', run: () => change((p) => ({ ...p, blocks: [...p.blocks, b] })) })
  }
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
        const moved = { ...b, id: done.length ? rid() : b.id, date: to, topics: b.topics.filter((t) => !t.done), order: Date.now(), spent: 0 }
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

  // ---- the focus timer
  const startFocus = (b: StudyBlock) => {
    if (focus && focus.id !== b.id && !confirm('Stop the timer that’s running and start this one?')) return
    if (focus && focus.id !== b.id) endFocus(true)
    chime().unlock()
    setFocus({ id: b.id, minutes: b.minutes || 25, start: Date.now(), paused: null, idle: 0 })
  }
  /** Stop the timer; `keep` logs the minutes done onto the block. */
  const endFocus = (keep: boolean) => {
    if (!focus) return
    const ms = (focus.paused ?? Date.now()) - focus.start - focus.idle
    const mins = Math.min(focus.minutes, Math.round(ms / 60000))
    const b = plan.blocks.find((x) => x.id === focus.id)
    if (keep && b && mins > 0) {
      setBlock(b.id, (x) => ({ ...x, spent: (x.spent || 0) + mins }))
      toast(`${fmtMin(mins)} of ${subj(b.subject)?.name || 'study'} logged`)
    }
    setFocus(null)
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
  const items = inRange.flatMap((b) => (b.topics.length ? b.topics : [{ done: b.done }]))
  const doneN = items.filter((t) => t.done).length
  const focused = inRange.reduce((n, b) => n + (b.spent || 0), 0)

  const label = `${short(days[0])} – ${short(days[days.length - 1])}`
  const subjectsUsed = plan.subjects.filter((s) => plan.blocks.some((b) => b.subject === s.id))
  const focusBlock = focus && plan.blocks.find((b) => b.id === focus.id)

  return (
    <div className={`sp-page${filter ? ' filtering' : ''}`}>
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
        <button className="btn ghost sm" onClick={() => setSubjectsOpen(true)}>Subjects &amp; tags</button>
        <button className="btn sm" onClick={() => setPlanOpen(true)}>Plan from exams</button>
      </div>

      <div className="sp-legend" aria-label="Key and filters">
        <span className="sp-key exam">Exam day</span>
        <span className="sp-key late">Late day</span>
        <span className="sp-key rest">Rest day</span>
        <span className="sp-legend-sep" aria-hidden="true" />
        <button className={`sp-chip${picked('mode', 'RE') ? ' on' : ''}`} aria-pressed={picked('mode', 'RE')} onClick={() => pick({ kind: 'mode', id: 'RE' })}><b>RE</b> revise / memorise</button>
        <button className={`sp-chip${picked('mode', 'P') ? ' on' : ''}`} aria-pressed={picked('mode', 'P')} onClick={() => pick({ kind: 'mode', id: 'P' })}><b>P</b> practice</button>
        <button className={`sp-chip prio${picked('prio', '') ? ' on' : ''}`} aria-pressed={picked('prio', '')} onClick={() => pick({ kind: 'prio', id: '' })}>Priority subject</button>
        {subjectsUsed.length > 1 && subjectsUsed.map((s) => (
          <button key={s.id} className={`sp-chip c-${s.color}${picked('subject', s.id) ? ' on' : ''}`} aria-pressed={picked('subject', s.id)} onClick={() => pick({ kind: 'subject', id: s.id })}><i className="swatch" aria-hidden="true" />{s.name}</button>
        ))}
        {tags.map((t) => (
          <button key={t.id} className={`sp-chip tag c-${t.color}${picked('tag', t.id) ? ' on' : ''}`} aria-pressed={picked('tag', t.id)} onClick={() => pick({ kind: 'tag', id: t.id })}>#{t.name}</button>
        ))}
        {filter && <button className="linkish" onClick={() => setFilter(null)}>Show all</button>}
      </div>

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
                const running = focus?.id === b.id
                const meta = [b.time && formatTime(b.time), b.minutes && fmtMin(b.minutes)].filter(Boolean).join(' · ')
                return (
                  <div
                    key={b.id}
                    className={`sp-block c-${s?.color || 'none'}${done ? ' done' : ''}${matches(b) ? '' : ' faded'}${running ? ' running' : ''}`}
                    draggable={topicFor !== b.id}
                    onDragStart={(e) => { drag.current = b.id; e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move' }}
                  >
                    <div className="sp-block-top">
                      <button className="sp-block-head" onClick={() => setEdit({ block: b, date: k })} title="Edit">
                        <span className={`sp-subject${s?.priority ? ' prio' : ''}`}>{s?.name || 'Subject'}</span>
                      </button>
                      <button className={`sp-mode${b.mode ? '' : ' empty'}`} onClick={() => setBlock(b.id, (x) => ({ ...x, mode: NEXT_MODE[x.mode] }))} title="Revise, practice or both (tap to change)">
                        {b.mode || 'RE/P'}
                      </button>
                      <button className={`sp-play${running ? ' on' : ''}`} onClick={() => (running ? endFocus(true) : startFocus(b))} aria-label={running ? 'Stop the focus timer' : 'Start a focus timer'} title={running ? 'Stop' : 'Focus timer'}>
                        {running ? <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" /></svg> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5v9l7.5-4.5z" /></svg>}
                      </button>
                    </div>
                    {(meta || b.spent > 0) && (
                      <div className="sp-meta">
                        {meta && <span>{meta}</span>}
                        {b.spent > 0 && <span className="sp-spent" title="Time on the focus timer">⏱ {fmtMin(b.spent)}</span>}
                      </div>
                    )}
                    {(b.tags || []).length > 0 && (
                      <div className="sp-tags">
                        {b.tags.map((id) => { const t = tags.find((x) => x.id === id); return t ? <span key={id} className={`sp-tagchip c-${t.color}`}>#{t.name}</span> : null })}
                      </div>
                    )}
                    {b.topics.length > 0 && (
                      <ul className="sp-topics">
                        {b.topics.map((t) => (
                          <li key={t.id}>
                            <button className={t.done ? 'done' : ''} onClick={() => toggleTopic(b, t.id)} aria-pressed={t.done}>{t.text}</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {topicFor === b.id ? (
                      <form onSubmit={(e) => { e.preventDefault(); const i = e.currentTarget.elements[0] as HTMLInputElement; addTopic(b, i.value); i.value = '' }}>
                        <input className="input sm sp-topic-input" autoFocus placeholder="Topic, then Enter" maxLength={120}
                          onBlur={(e) => { addTopic(b, e.target.value); setTopicFor(null) }}
                          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setTopicFor(null) } }} />
                      </form>
                    ) : (
                      <div className="sp-block-foot">
                        {!b.topics.length && <button className={`sp-whole${b.done ? ' done' : ''}`} onClick={() => setBlock(b.id, (x) => ({ ...x, done: !x.done }))} aria-pressed={b.done}>{b.done ? '✓ Done' : '○ Mark done'}</button>}
                        <button className="sp-addtopic" onClick={() => setTopicFor(b.id)}>+ topic</button>
                      </div>
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

      <Progress plan={plan} days={days} label={label} done={doneN} total={items.length} focused={focused} />

      {focus && focusBlock && (
        <FocusTimer
          focus={focus}
          subject={subj(focusBlock.subject)}
          block={focusBlock}
          onChange={setFocus}
          onEnd={endFocus}
        />
      )}

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
          onSave={(b, extra) => {
            change((p) => {
              const subjects = extra.subject ? [...p.subjects, extra.subject] : p.subjects
              const withPrio = extra.priority === undefined ? subjects : subjects.map((s) => (s.id === b.subject ? { ...s, priority: extra.priority! } : s))
              const exists = p.blocks.some((x) => x.id === b.id)
              const blocks = exists ? p.blocks.map((x) => (x.id === b.id ? b : x)) : [...p.blocks, b]
              // "repeat weekly": fresh copies on the same weekday
              const copies = Array.from({ length: extra.repeat }, (_, i) => ({ ...b, id: rid(), date: addDays(b.date, 7 * (i + 1)), topics: b.topics.map((t) => ({ ...t, id: rid(), done: false })), done: false, spent: 0, order: Date.now() + i }))
              return { ...p, subjects: withPrio, tags: extra.tags || p.tags, blocks: [...blocks, ...copies] }
            })
            if (extra.repeat) toast(`Added ${extra.repeat} more, one a week`)
            setEdit(null)
          }}
          onDelete={edit.block ? () => { removeBlock(edit.block!); setEdit(null) } : undefined}
        />
      )}
      {subjectsOpen && <SubjectsDialog plan={plan} examSubjects={[...new Set(exams.map((e) => e.subject))]} onChange={change} onClose={() => setSubjectsOpen(false)} />}
      {planOpen && <PlanDialog plan={plan} exams={exams.filter((e) => e.date > today)} today={today} onChange={change} onClose={() => setPlanOpen(false)} onExams={onExams} />}
    </div>
  )
}

// ------------------------------------------------------------- progress
function Progress({ plan, days, label, done, total, focused }: { plan: StudyPlan; days: string[]; label: string; done: number; total: number; focused: number }) {
  const from = days[0], to = days[days.length - 1]
  const blocks = plan.blocks.filter((b) => b.date >= from && b.date <= to)
  if (!blocks.length) return null
  const studyDays = new Set(blocks.filter((b) => b.spent > 0 || b.topics.some((t) => t.done) || b.done).map((b) => b.date)).size
  const rows = plan.subjects.map((s) => {
    const bs = blocks.filter((b) => b.subject === s.id)
    const its = bs.flatMap((b) => (b.topics.length ? b.topics : [{ done: b.done }]))
    return { s, n: its.length, done: its.filter((t) => t.done).length, mins: bs.reduce((n, b) => n + (b.spent || 0), 0) }
  }).filter((r) => r.n)
  return (
    <section className="sp-progress card" aria-label="Progress">
      <div className="sp-prog-head">
        <b>{label}</b>
        <span className="sp-prog-stats">
          <span><b>{done}</b>/{total} topics</span>
          <span><b>{focused ? fmtMin(focused) : '0m'}</b> focused</span>
          <span><b>{studyDays}</b> study day{studyDays === 1 ? '' : 's'}</span>
        </span>
      </div>
      <ul className="sp-prog-list">
        {rows.map(({ s, n, done, mins }) => (
          <li key={s.id} className={`c-${s.color}`}>
            <span className={`sp-prog-name${s.priority ? ' prio' : ''}`}>{s.name}</span>
            <span className="sp-prog-bar" aria-hidden="true"><i style={{ width: `${(done / n) * 100}%` }} /></span>
            <span className="sp-prog-num">{done}/{n}{mins ? ` · ${fmtMin(mins)}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------- focus timer
function FocusTimer({ focus, subject, block, onChange, onEnd }: { focus: Focus; subject?: StudySubject; block: StudyBlock; onChange: (f: Focus) => void; onEnd: (keep: boolean) => void }) {
  const [, tick] = useState(0)
  const rang = useRef(false)
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  const elapsed = (focus.paused ?? Date.now()) - focus.start - focus.idle
  const left = Math.max(0, focus.minutes * 60000 - elapsed)
  useEffect(() => {
    if (left > 0 || rang.current) return
    rang.current = true
    chime().play()
    onEnd(true)
  }, [left]) // eslint-disable-line react-hooks/exhaustive-deps
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000)
  const pct = Math.min(100, (elapsed / (focus.minutes * 60000)) * 100)
  const pause = () => onChange(focus.paused ? { ...focus, idle: focus.idle + (Date.now() - focus.paused), paused: null } : { ...focus, paused: Date.now() })
  return (
    <div className={`sp-focus c-${subject?.color || 'none'}`} role="timer" aria-label="Focus timer">
      <div className="sp-focus-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      <div className="sp-focus-main">
        <span className="sp-focus-what">
          <b className={subject?.priority ? 'prio' : ''}>{subject?.name || 'Study'}</b>
          <small>{[block.mode, block.topics.find((t) => !t.done)?.text].filter(Boolean).join(' · ') || 'Focus'}</small>
        </span>
        <span className="sp-focus-time">{String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}</span>
      </div>
      <div className="sp-focus-actions">
        <button className="btn ghost sm" onClick={pause}>{focus.paused ? 'Resume' : 'Pause'}</button>
        <button className="btn ghost sm" onClick={() => onChange({ ...focus, minutes: focus.minutes + 5 })}>+5 min</button>
        <span className="spacer" />
        <button className="btn quiet sm" onClick={() => onEnd(false)} title="Stop without logging">Cancel</button>
        <button className="btn sm" onClick={() => onEnd(true)}>Done</button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- dialogs
type Extra = { subject?: StudySubject; priority?: boolean; tags?: StudyTag[]; repeat: number }

function BlockDialog({ plan, block, date, onClose, onSave, onDelete }: {
  plan: StudyPlan; block?: StudyBlock; date: string; onClose: () => void
  onSave: (b: StudyBlock, extra: Extra) => void; onDelete?: () => void
}) {
  const [subject, setSubject] = useState(block?.subject || plan.subjects[0]?.id || '')
  const [newName, setNewName] = useState('')
  const [mode, setMode] = useState<StudyMode>(block?.mode ?? 'RE')
  const [text, setText] = useState((block?.topics || []).map((t) => t.text).join('\n'))
  const [note, setNote] = useState(block?.note || '')
  const [day, setDay] = useState(block?.date || date)
  const [time, setTime] = useState(block?.time || '')
  const [minutes, setMinutes] = useState<number | null>(block?.minutes ?? null)
  const [tagIds, setTagIds] = useState<string[]>(block?.tags || [])
  const [tags, setTags] = useState<StudyTag[]>(plan.tags || [])
  const [newTag, setNewTag] = useState<string | null>(null)
  const [repeat, setRepeat] = useState(0)
  const creating = subject === '__new'
  const cur = plan.subjects.find((s) => s.id === subject)
  const [prio, setPrio] = useState(!!cur?.priority)
  useEffect(() => { setPrio(!!plan.subjects.find((s) => s.id === subject)?.priority) }, [subject]) // eslint-disable-line react-hooks/exhaustive-deps

  const addTag = () => {
    const name = (newTag || '').trim().replace(/^#/, '').slice(0, 24)
    setNewTag(null)
    if (!name) return
    const same = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (same) { setTagIds((x) => [...new Set([...x, same.id])]); return }
    const t: StudyTag = { id: rid(), name, color: COLORS[tags.length % (COLORS.length - 1)] }
    setTags((x) => [...x, t])
    setTagIds((x) => [...x, t.id])
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    let sid = subject
    let made: StudySubject | undefined
    if (creating) {
      const name = newName.trim()
      if (!name) return toast('Name the subject')
      const same = plan.subjects.find((s) => s.name.toLowerCase() === name.toLowerCase())
      if (same) sid = same.id
      else { made = { id: rid(), name, color: colorOfSubject(name), priority: prio }; sid = made.id }
    }
    if (!sid) return toast('Pick a subject')
    // keep ticks on topics that are still there
    const old = new Map((block?.topics || []).map((t) => [t.text, t]))
    const topics = text.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 40).map((x) => old.get(x) || { id: rid(), text: x.slice(0, 120), done: false })
    onSave(
      { id: block?.id || rid(), date: day || date, subject: sid, mode, topics, note: note.trim(), tags: tagIds.filter((id) => tags.some((t) => t.id === id)), time: time || null, minutes, spent: block?.spent || 0, done: block?.done || false, order: block?.order ?? Date.now() },
      { subject: made, priority: made ? undefined : prio !== !!cur?.priority ? prio : undefined, tags: tags.length !== (plan.tags || []).length ? tags : undefined, repeat },
    )
  }
  return (
    <Dialog title={block ? 'Edit study' : `Study on ${WEEKDAYS[fromKey(date).getDay()]} ${short(date)}`} onClose={onClose} className="sp-dialog" closeButton>
      <form onSubmit={submit}>
        <div className="sp-form-row wide">
          <label className="field"><span>Subject</span>
            <Select className="input" value={subject} onChange={(e) => setSubject(e.target.value)}>
              {plan.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="__new">+ New subject…</option>
            </Select>
          </label>
          <label className="toggle tight sp-prio-toggle">
            <input type="checkbox" checked={prio} onChange={(e) => setPrio(e.target.checked)} />
            <span className={prio ? 'prio' : ''}>Priority subject</span>
          </label>
        </div>
        {creating && <label className="field"><span>New subject</span><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} autoFocus placeholder="Additional Mathematics" /></label>}
        <div className="field"><span className="label">How</span>
          <div className="seg" role="radiogroup" aria-label="How">
            {MODES.map((m) => <button key={m.v || 'none'} type="button" role="radio" aria-checked={mode === m.v} className={mode === m.v ? 'on' : ''} title={m.help} onClick={() => setMode(m.v)}>{m.label}</button>)}
          </div>
          <span className="help">{MODES.find((m) => m.v === mode)?.help}</span>
        </div>
        <label className="field"><span>Topics</span>
          <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'One per line\nRedox chemistry\nRate of reactions'} />
        </label>
        <div className="field"><span className="label">Tags</span>
          <div className="sp-tagpick">
            {tags.map((t) => {
              const on = tagIds.includes(t.id)
              return <button key={t.id} type="button" className={`sp-chip tag c-${t.color}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setTagIds((x) => (on ? x.filter((y) => y !== t.id) : [...x, t.id]))}>#{t.name}</button>
            })}
            {newTag === null ? (
              <button type="button" className="sp-chip add" onClick={() => setNewTag('')}>+ New tag</button>
            ) : (
              <input className="input sm sp-newtag" autoFocus value={newTag} maxLength={24} placeholder="Past paper"
                onChange={(e) => setNewTag(e.target.value)} onBlur={addTag}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } else if (e.key === 'Escape') { e.stopPropagation(); setNewTag(null) } }} />
            )}
          </div>
        </div>
        <div className="sp-form-row three">
          <label className="field"><span>Day</span><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
          <label className="field"><span>Start</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <label className="field"><span>Length</span>
            <Select className="input" value={String(minutes || '')} onChange={(e) => setMinutes(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {LENGTHS.map((m) => <option key={m} value={String(m)}>{fmtMin(m)}</option>)}
            </Select>
          </label>
        </div>
        <div className="sp-form-row">
          <label className="field"><span>Note</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Section B, essay…" /></label>
          <label className="field"><span>Repeat</span>
            <Select className="input" value={String(repeat)} onChange={(e) => setRepeat(Number(e.target.value))}>
              <option value="0">Just this day</option>
              <option value="1">Next week too</option>
              {[3, 4, 6, 8].map((n) => <option key={n} value={String(n - 1)}>Weekly, {n} weeks</option>)}
            </Select>
          </label>
        </div>
        {time && <p className="help sp-remind-note">Buddy can nudge you on WhatsApp at {formatTime(time)} (Settings → WhatsApp Buddy).</p>}
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
  const [tagName, setTagName] = useState('')
  const tags = plan.tags || []
  const missing = examSubjects.filter((x) => !plan.subjects.some((s) => s.name.toLowerCase() === x.toLowerCase()))
  const set = (id: string, patch: Partial<StudySubject>) => onChange((p) => ({ ...p, subjects: p.subjects.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))
  const setTag = (id: string, patch: Partial<StudyTag>) => onChange((p) => ({ ...p, tags: (p.tags || []).map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  const add = (names: string[]) => onChange((p) => ({ ...p, subjects: [...p.subjects, ...names.map((n) => ({ id: rid(), name: n.slice(0, 40), color: colorOfSubject(n), priority: false }))] }))
  const remove = (s: StudySubject) => {
    const n = plan.blocks.filter((b) => b.subject === s.id).length
    if (n && !confirm(`Delete ${s.name} and its ${n} study block${n === 1 ? '' : 's'}?`)) return
    onChange((p) => ({ ...p, subjects: p.subjects.filter((x) => x.id !== s.id), blocks: p.blocks.filter((b) => b.subject !== s.id) }))
  }
  const removeTag = (t: StudyTag) => onChange((p) => ({ ...p, tags: (p.tags || []).filter((x) => x.id !== t.id), blocks: p.blocks.map((b) => ({ ...b, tags: (b.tags || []).filter((x) => x !== t.id) })) }))
  const addTag = () => {
    const n = tagName.trim().replace(/^#/, '').slice(0, 24)
    if (!n || tags.some((t) => t.name.toLowerCase() === n.toLowerCase())) return
    onChange((p) => ({ ...p, tags: [...(p.tags || []), { id: rid(), name: n, color: COLORS[(p.tags || []).length % (COLORS.length - 1)] }] }))
    setTagName('')
  }
  return (
    <Dialog title="Subjects & tags" onClose={onClose} className="sp-subjects" closeButton>
      <h3 className="sp-sub-title">Subjects</h3>
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
              <button className={`btn ghost sm sp-prio${s.priority ? ' on' : ''}`} aria-pressed={s.priority} onClick={() => set(s.id, { priority: !s.priority })}>{s.priority ? '★ Priority' : '☆ Priority'}</button>
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

      <h3 className="sp-sub-title">Tags</h3>
      <p className="help">Your own labels for study blocks, like past paper, flashcards or teacher’s list.</p>
      <ul className="sp-subject-list">
        {tags.map((t) => (
          <li key={t.id}>
            <button className={`sp-color c-${t.color}`} aria-label={`Colour of ${t.name}`} title="Change colour"
              onClick={() => setTag(t.id, { color: COLORS[(COLORS.indexOf(t.color) + 1) % COLORS.length] })} />
            <input className="input sm" defaultValue={t.name} maxLength={24} aria-label="Tag name"
              onBlur={(e) => { const v = e.target.value.trim().replace(/^#/, ''); if (v && v !== t.name) setTag(t.id, { name: v }) }} />
            <span className="help sp-subject-n">{plan.blocks.filter((b) => (b.tags || []).includes(t.id)).length || ''}</span>
            <button className="icon-btn sm" aria-label={`Delete ${t.name}`} onClick={() => removeTag(t)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg></button>
          </li>
        ))}
      </ul>
      <form className="row sp-subject-add" onSubmit={(e) => { e.preventDefault(); addTag() }}>
        <input className="input sm" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="Add a tag" maxLength={24} aria-label="New tag" />
        <button className="btn sm" disabled={!tagName.trim()}>Add</button>
      </form>
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
        blocks.push({ id: rid(), date: day, subject: s.id, mode: st.mode, topics: [], note: `For ${examTitle(e)} on ${short(e.date)}`, tags: [], time: null, minutes: null, spent: 0, done: false, order: Date.now() + blocks.length })
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
