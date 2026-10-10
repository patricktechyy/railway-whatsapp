import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react'
import { addDays, daysBetween, formatTime, fromKey, MONTHS, WEEKDAYS } from '../dates'
import type { Exam, StudyBlock, StudyPlan, StudySubject } from '../types'
import type { StudyApi } from '../useStudy'
import { Icon } from '../components/Icon'
import { examTitle, subjectColor } from './ExamsView'

/**
 * The study planner's Today tab: one day, laid out on a timeline.
 *
 * Left: the day's hours, with each study session where it sits and as long as it runs
 * (drag one up or down to move it, 15 minutes at a time), a line at the current time,
 * and above it the sessions that have no time yet (drag them onto the timeline to give
 * them one). Right: the session you're on (or the next one) in full, with its topics to
 * tick and the focus timer, then how the day is going, the day's tests, the exams ahead,
 * and a look at tomorrow.
 */

export type Focus = { id: string; minutes: number; start: number; paused: number | null; idle: number }
type Props = {
  plan: StudyPlan
  change: StudyApi['change']
  exams: Exam[]
  date: string
  today: string
  setDate: (k: string) => void
  focus: Focus | null
  onStartFocus: (b: StudyBlock) => void
  onStopFocus: () => void
  onFocusChange: (f: Focus) => void
  onEdit: (b: StudyBlock) => void
  onAdd: (date: string) => void
  onPushOn: (date: string) => void
  onPlan: () => void
}

const SNAP = 15
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const fmtMin = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`)
const done = (b: StudyBlock) => (b.topics.length ? b.topics.every((t) => t.done) : b.done)
const byTime = (a: StudyBlock, b: StudyBlock) => (a.time || '99').localeCompare(b.time || '99') || a.order - b.order
const dayName = (k: string) => { const d = fromKey(k); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` }
const shortDay = (k: string) => { const d = fromKey(k); return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}` }
const rid = () => Math.random().toString(36).slice(2, 10)
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
/** How long a session takes on the timeline when no length was set. */
const lenOf = (b: StudyBlock) => b.minutes || 60
const range = (b: StudyBlock) => b.time ? `${formatTime(b.time)} – ${formatTime(toHm(Math.min(24 * 60 - 1, toMin(b.time) + lenOf(b))))}` : 'Any time'

/** Side-by-side lanes for sessions that overlap in time. */
function lanes(blocks: StudyBlock[]) {
  const out = new Map<string, { lane: number; of: number }>()
  const timed = blocks.filter((b) => b.time).sort(byTime)
  let group: StudyBlock[] = [], groupEnd = -1
  const flush = () => {
    const ends: number[] = []
    const lane = new Map<string, number>()
    for (const b of group) {
      const s = toMin(b.time!)
      let i = ends.findIndex((e) => e <= s)
      if (i < 0) { i = ends.length; ends.push(0) }
      ends[i] = s + lenOf(b)
      lane.set(b.id, i)
    }
    for (const b of group) out.set(b.id, { lane: lane.get(b.id)!, of: ends.length })
    group = []
  }
  for (const b of timed) {
    const s = toMin(b.time!)
    if (group.length && s >= groupEnd) flush()
    group.push(b)
    groupEnd = Math.max(groupEnd, s + lenOf(b))
  }
  if (group.length) flush()
  return out
}

export function StudyToday({ plan, change, exams, date, today, setDate, focus, onStartFocus, onStopFocus, onFocusChange, onEdit, onAdd, onPushOn, onPlan }: Props) {
  const [, tick] = useState(0)
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), focus ? 1000 : 30000); return () => clearInterval(t) }, [focus])
  const phone = typeof window !== 'undefined' && window.innerWidth < 760
  const HOUR = phone ? 56 : 72
  const PX = HOUR / 60

  const subj = (id: string): StudySubject | undefined => plan.subjects.find((s) => s.id === id)
  const blocks = plan.blocks.filter((b) => b.date === date).sort(byTime)
  const timed = blocks.filter((b) => b.time)
  const anytime = blocks.filter((b) => !b.time)
  const isToday = date === today
  const now = nowMin()

  // the hours shown: from an hour before the first thing (or now) to two after the last (room to drop
  // something later), at least 8 hours
  const marks = [...timed.flatMap((b) => [toMin(b.time!), toMin(b.time!) + lenOf(b)]), ...(isToday ? [now] : [])]
  let startH = marks.length ? Math.max(0, Math.floor(Math.min(...marks) / 60) - 1) : 8
  let endH = marks.length ? Math.min(24, Math.ceil(Math.max(...marks) / 60) + 2) : 20
  if (endH - startH < 8) { endH = Math.min(24, startH + 8); startH = Math.max(0, endH - 8) }
  const lane = useMemo(() => lanes(blocks), [plan, date]) // eslint-disable-line react-hooks/exhaustive-deps

  // which session the right-hand card shows: yours if you picked one, else the one you're
  // focusing on, the one happening now, the next one, the first one not done
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => { setPicked(null) }, [date])
  const running = focus && blocks.find((b) => b.id === focus.id)
  const current = isToday ? timed.find((b) => toMin(b.time!) <= now && now < toMin(b.time!) + lenOf(b)) : undefined
  const next = isToday ? timed.find((b) => toMin(b.time!) > now && !done(b)) : undefined
  const sel = blocks.find((b) => b.id === picked) || running || current || next || blocks.find((b) => !done(b)) || blocks[0]

  // ---- changes
  const setBlock = (id: string, fn: (b: StudyBlock) => StudyBlock) => change((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === id ? fn(b) : b)) }))
  const toggleTopic = (b: StudyBlock, tid: string) => setBlock(b.id, (x) => ({ ...x, topics: x.topics.map((t) => (t.id === tid ? { ...t, done: !t.done } : t)) }))
  const addTopic = (b: StudyBlock, text: string) => { const t = text.trim().slice(0, 120); if (t) setBlock(b.id, (x) => ({ ...x, topics: [...x.topics, { id: rid(), text: t, done: false }] })) }

  // ---- drag a session up or down the timeline (or one from "Any time" onto it)
  const line = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: string; y: number; orig: number; delta: number; moved: boolean } | null>(null)
  const minuteAt = (clientY: number) => {
    const r = line.current!.getBoundingClientRect()
    const m = startH * 60 + (clientY - r.top) / PX
    return Math.max(startH * 60, Math.min(endH * 60 - SNAP, Math.round(m / SNAP) * SNAP))
  }
  const down = (e: RPointerEvent<HTMLDivElement>, b: StudyBlock) => {
    if ((e.target as HTMLElement).closest('button, input') || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id: b.id, y: e.clientY, orig: toMin(b.time!), delta: 0, moved: false })
  }
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    const dy = e.clientY - drag.y
    if (!drag.moved && Math.abs(dy) < 5) return
    const delta = Math.round(dy / PX / SNAP) * SNAP
    const lo = startH * 60 - drag.orig, hi = endH * 60 - SNAP - drag.orig
    setDrag({ ...drag, moved: true, delta: Math.max(lo, Math.min(hi, delta)) })
  }
  const up = () => {
    if (!drag) return
    if (drag.moved && drag.delta) setBlock(drag.id, (x) => ({ ...x, time: toHm(drag.orig + drag.delta) }))
    else if (!drag.moved) setPicked(drag.id)
    setDrag(null)
  }
  const [hover, setHover] = useState<number | null>(null)
  const dropOn = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    const m = minuteAt(e.clientY)
    setHover(null)
    if (id && blocks.some((b) => b.id === id)) { setBlock(id, (x) => ({ ...x, time: toHm(m) })); setPicked(id) }
  }

  // the timeline scrolls on its own on wide screens: open it at the current time (or the first session)
  const nowRef = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const c = box.current
    if (!c || c.scrollHeight <= c.clientHeight) return
    const el = nowRef.current || line.current?.querySelector<HTMLElement>('.st-block')
    if (el) c.scrollTop = Math.max(0, el.offsetTop - c.clientHeight / 3)
  }, [date]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the day in numbers
  const items = blocks.flatMap((b) => (b.topics.length ? b.topics : [{ done: b.done }]))
  const doneN = items.filter((t) => t.done).length
  const planned = blocks.reduce((n, b) => n + (b.minutes || 0), 0)
  const spent = blocks.reduce((n, b) => n + (b.spent || 0), 0)
  const finished = blocks.filter(done).length
  const kind = plan.days[date]
  const testsToday = [...exams.filter((e) => e.date === date).map((e) => ({ id: e.id, title: examTitle(e), time: e.start, exam: true, cls: subjectColor(e.subject) })), ...plan.tests.filter((t) => t.date === date).map((t) => ({ id: t.id, title: t.title, time: null as string | null, exam: false, cls: '' }))]
  const ahead = exams.filter((e) => e.date > date).sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '')).slice(0, 4)
  const tomorrow = addDays(date, 1)
  const tomorrowBlocks = plan.blocks.filter((b) => b.date === tomorrow).sort(byTime)

  const pct = items.length ? doneN / items.length : 0
  const R = 30, C = 2 * Math.PI * R

  return (
    <div className={`st${phone ? ' phone' : ''}`}>
      <div className="st-main">
        {anytime.length > 0 && (
          <section className="st-anytime" aria-label="Any time today">
            <h3>Any time <small>drag one onto the timeline to give it a time</small></h3>
            <div className="st-anytime-list">
              {anytime.map((b) => {
                const s = subj(b.subject)
                return (
                  <button key={b.id} type="button" draggable className={`st-chip c-${s?.color || 'none'}${sel?.id === b.id ? ' on' : ''}${done(b) ? ' done' : ''}`}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move' }}
                    onClick={() => setPicked(b.id)}>
                    <b className={s?.priority ? 'prio' : ''}>{s?.name || 'Study'}</b>
                    <small>{[b.mode, b.topics.length ? `${b.topics.filter((t) => t.done).length}/${b.topics.length} topics` : '', b.minutes ? fmtMin(b.minutes) : ''].filter(Boolean).join(' · ')}</small>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {!blocks.length && (
          <div className="st-empty card">
            <b>{kind === 'rest' ? 'Rest day.' : `Nothing planned for ${isToday ? 'today' : dayName(date)}.`}</b>
            <p className="help">{kind === 'rest' ? 'Enjoy it. You can still add something if you want to.' : 'Add a study session, or let the planner fill in revision before your exams.'}</p>
            <div className="row">
              <button className="btn sm" onClick={() => onAdd(date)}>Add study</button>
              {kind !== 'rest' && <button className="btn ghost sm" onClick={onPlan}>Plan from exams</button>}
            </div>
          </div>
        )}

        <div className="st-timeline" ref={box} style={{ ['--hour' as string]: `${HOUR}px` }}>
          <div className="st-hours" aria-hidden="true">
            {Array.from({ length: endH - startH }, (_, i) => <span key={i}>{formatTime(toHm((startH + i) * 60))}</span>)}
          </div>
          <div
            className={`st-line${hover !== null ? ' dropping' : ''}`}
            ref={line}
            style={{ height: (endH - startH) * HOUR }}
            onDragOver={(e) => { e.preventDefault(); setHover(minuteAt(e.clientY)) }}
            onDragLeave={() => setHover(null)}
            onDrop={dropOn}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => setDrag(null)}
          >
            {Array.from({ length: endH - startH }, (_, i) => <i key={i} className="st-rule" style={{ top: i * HOUR }} />)}
            {hover !== null && <div className="st-ghost" style={{ top: (hover - startH * 60) * PX }}><span>{formatTime(toHm(hover))}</span></div>}
            {isToday && now >= startH * 60 && now < endH * 60 && (
              <div className="st-now" ref={nowRef} style={{ top: (now - startH * 60) * PX }}><span>{formatTime(toHm(now))}</span></div>
            )}
            {timed.map((b) => {
              const s = subj(b.subject)
              const l = lane.get(b.id) || { lane: 0, of: 1 }
              const moving = drag?.id === b.id && drag.moved
              const start = toMin(b.time!) + (moving ? drag!.delta : 0)
              const h = Math.max(lenOf(b) * PX, 30)
              const ts = b.topics.length, td = b.topics.filter((t) => t.done).length
              const isRunning = focus?.id === b.id
              const past = isToday && start + lenOf(b) <= now
              return (
                <div
                  key={b.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${s?.name || 'Study'}, ${range({ ...b, time: toHm(start) })}${ts ? `, ${td} of ${ts} topics done` : ''}`}
                  aria-pressed={sel?.id === b.id}
                  className={`st-block c-${s?.color || 'none'}${sel?.id === b.id ? ' on' : ''}${done(b) ? ' done' : ''}${moving ? ' moving' : ''}${isRunning ? ' running' : ''}${past ? ' past' : ''}${h < 52 ? ' small' : ''}`}
                  style={{ top: (start - startH * 60) * PX, height: h, left: `calc(${(l.lane / l.of) * 100}% + 4px)`, width: `calc(${100 / l.of}% - 8px)` }}
                  onPointerDown={(e) => down(e, b)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(b.id) } }}
                >
                  <span className="st-b-top">
                    <b className={s?.priority ? 'prio' : ''}>{s?.name || 'Study'}</b>
                    {b.mode && <span className="st-mode">{b.mode}</span>}
                  </span>
                  <span className="st-b-time">{moving ? `${formatTime(toHm(start))} ↕` : range(b)}</span>
                  {ts > 0 && h >= 90 && (
                    <span className="st-b-topics">
                      {b.topics.map((t) => <span key={t.id} className={t.done ? 'done' : ''}>{t.text}</span>)}
                    </span>
                  )}
                  <span className="st-b-prog" aria-hidden="true"><i style={{ width: `${(ts ? td / ts : done(b) ? 1 : 0) * 100}%` }} /></span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <aside className="st-side">
        {sel && <SessionCard key={sel.id} b={sel} s={subj(sel.subject)} plan={plan} isToday={isToday} now={now} focus={focus}
          onToggle={(tid) => toggleTopic(sel, tid)} onAddTopic={(t) => addTopic(sel, t)} onWhole={() => setBlock(sel.id, (x) => ({ ...x, done: !x.done }))}
          onStart={() => onStartFocus(sel)} onStop={onStopFocus} onFocusChange={onFocusChange} onEdit={() => onEdit(sel)}
          onTomorrow={() => { setBlock(sel.id, (x) => ({ ...x, date: tomorrow, order: Date.now() })); setPicked(null) }} />}

        {blocks.length > 0 && (
          <section className="st-card st-day" aria-label="How the day is going">
            <svg className="st-ring" viewBox="0 0 72 72" aria-hidden="true">
              <circle cx="36" cy="36" r={R} className="bg" />
              <circle cx="36" cy="36" r={R} className="fg" style={{ strokeDasharray: C, strokeDashoffset: C * (1 - pct) }} />
            </svg>
            <div className="st-day-text">
              <b>{doneN} of {items.length} {items.length === 1 ? 'topic' : 'topics'} done</b>
              <span>{finished} of {blocks.length} {blocks.length === 1 ? 'session' : 'sessions'} finished</span>
              <span>{spent ? `${fmtMin(spent)} focused` : 'Nothing focused yet'}{planned ? ` of ${fmtMin(planned)} planned` : ''}</span>
            </div>
            {date <= today && finished < blocks.length && <button className="btn ghost sm st-push" onClick={() => onPushOn(date)}>Move unfinished to next day</button>}
          </section>
        )}

        {testsToday.length > 0 && (
          <section className="st-card" aria-label="Tests">
            <h3>{isToday ? 'Tests today' : 'Tests that day'}</h3>
            <ul className="st-list">
              {testsToday.map((t) => (
                <li key={t.id} className={t.exam ? `st-exam ${t.cls}` : ''}><b>{t.title}</b>{t.time && <small>{formatTime(t.time)}</small>}{t.exam && <small>Exam</small>}</li>
              ))}
            </ul>
          </section>
        )}

        {ahead.length > 0 && (
          <section className="st-card" aria-label="Exams ahead">
            <h3>Exams ahead</h3>
            <ul className="st-list">
              {ahead.map((e) => {
                const n = daysBetween(date, e.date)
                return <li key={e.id} className={subjectColor(e.subject)}><i className="swatch" aria-hidden="true" /><b>{examTitle(e)}</b><small>{shortDay(e.date)} · {n === 1 ? 'tomorrow' : `in ${n} days`}</small></li>
              })}
            </ul>
          </section>
        )}

        <section className="st-card" aria-label="The next day">
          <h3><button type="button" className="linkish" onClick={() => setDate(tomorrow)}>{tomorrow === addDays(today, 1) ? 'Tomorrow' : shortDay(tomorrow)}</button></h3>
          {tomorrowBlocks.length ? (
            <ul className="st-list">
              {tomorrowBlocks.map((b) => { const s = subj(b.subject); return <li key={b.id} className={`c-${s?.color || 'none'}`}><i className="swatch" aria-hidden="true" /><b className={s?.priority ? 'prio' : ''}>{s?.name || 'Study'}</b><small>{b.time ? formatTime(b.time) : 'Any time'}{b.minutes ? ` · ${fmtMin(b.minutes)}` : ''}</small></li> })}
            </ul>
          ) : <p className="help">{plan.days[tomorrow] === 'rest' ? 'Rest day.' : 'Nothing planned yet.'}</p>}
        </section>
      </aside>
    </div>
  )
}

/** One session in full: what it is, its topics to tick, the focus timer, and what you can do with it. */
function SessionCard({ b, s, plan, isToday, now, focus, onToggle, onAddTopic, onWhole, onStart, onStop, onFocusChange, onEdit, onTomorrow }: {
  b: StudyBlock; s?: StudySubject; plan: StudyPlan; isToday: boolean; now: number; focus: Focus | null
  onToggle: (tid: string) => void; onAddTopic: (t: string) => void; onWhole: () => void
  onStart: () => void; onStop: () => void; onFocusChange: (f: Focus) => void; onEdit: () => void; onTomorrow: () => void
}) {
  const [topic, setTopic] = useState('')
  const running = focus?.id === b.id
  const start = b.time ? toMin(b.time) : null
  const label = running ? 'Focusing'
    : done(b) ? 'Done'
    : !isToday || start === null ? 'Session'
    : now < start ? (start - now <= 90 ? `Up next · in ${fmtMin(start - now)}` : `Later · ${formatTime(b.time!)}`)
    : now < start + lenOf(b) ? 'Now' : 'Earlier today'
  const tags = (b.tags || []).map((id) => plan.tags.find((t) => t.id === id)).filter(Boolean)
  let clock = ''
  let pct = 0
  if (running && focus) {
    const elapsed = (focus.paused ?? Date.now()) - focus.start - focus.idle
    const left = Math.max(0, focus.minutes * 60000 - elapsed)
    clock = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
    pct = Math.min(1, elapsed / (focus.minutes * 60000))
  }
  return (
    <section className={`st-card st-session c-${s?.color || 'none'}${running ? ' running' : ''}`} aria-label={`${s?.name || 'Study'} session`}>
      <span className={`st-label${label === 'Now' || running ? ' live' : ''}`}>{label}</span>
      <h2 className={s?.priority ? 'prio' : ''}>{s?.name || 'Study'}</h2>
      <p className="st-meta">
        <span>{range(b)}</span>
        {b.mode && <span className="st-mode">{b.mode}</span>}
        {tags.map((t) => <span key={t!.id} className={`sp-tagchip c-${t!.color}`}>#{t!.name}</span>)}
      </p>
      {b.note && <p className="st-note">{b.note}</p>}

      {b.topics.length > 0 ? (
        <ul className="st-topics">
          {b.topics.map((t) => (
            <li key={t.id}>
              <label className={t.done ? 'done' : ''}>
                <input type="checkbox" checked={t.done} onChange={() => onToggle(t.id)} />
                <span>{t.text}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <label className={`st-whole${b.done ? ' done' : ''}`}><input type="checkbox" checked={b.done} onChange={onWhole} /><span>{b.done ? 'Done' : 'Mark the session done'}</span></label>
      )}
      <form className="st-addtopic" onSubmit={(e) => { e.preventDefault(); onAddTopic(topic); setTopic('') }}>
        <input className="input sm" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Add a topic" maxLength={120} aria-label="Add a topic" />
      </form>

      <div className="st-focus">
        {running ? (
          <>
            <div className="st-clock" role="timer" aria-label="Time left">{clock}{focus?.paused ? <small> paused</small> : null}</div>
            <div className="st-focus-bar" aria-hidden="true"><i style={{ width: `${pct * 100}%` }} /></div>
            <div className="st-focus-btns">
              <button className="btn ghost sm" onClick={() => focus && onFocusChange(focus.paused ? { ...focus, idle: focus.idle + (Date.now() - focus.paused), paused: null } : { ...focus, paused: Date.now() })}>{focus?.paused ? 'Resume' : 'Pause'}</button>
              <button className="btn ghost sm" onClick={() => focus && onFocusChange({ ...focus, minutes: focus.minutes + 5 })}>+5 min</button>
              <span className="spacer" />
              <button className="btn sm" onClick={onStop}>Stop and log it</button>
            </div>
          </>
        ) : (
          <button className="btn st-start" onClick={onStart} disabled={!!focus && !running} title={focus ? 'Another timer is running' : undefined}>
            <Icon name="timer" />Start focus · {fmtMin(b.minutes || 25)}
          </button>
        )}
        {(b.spent > 0 || b.minutes) && (
          <p className="help st-spent">{b.spent ? fmtMin(b.spent) : '0m'} focused{b.minutes ? ` of ${fmtMin(b.minutes)}` : ''}</p>
        )}
      </div>

      <div className="st-actions">
        <button className="btn ghost sm" onClick={onEdit}><Icon name="pencil" />Edit</button>
        {!done(b) && <button className="btn ghost sm" onClick={onTomorrow}>Move to next day</button>}
      </div>
    </section>
  )
}
