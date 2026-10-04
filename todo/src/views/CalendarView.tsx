import { colorClass } from '../listColor'
import { useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import { MONTHS, WEEKDAYS, addDays, daysBetween, formatDay, formatTime, fromKey, todayKey, toKey } from '../dates'
import type { DayNote, List, Task } from '../types'
import { occurrencesBetween } from '../repeat'

interface Props {
  tasks: Task[]
  lists: List[]
  weekStartsMonday: boolean
  selected: string | null
  onSelect: (day: string | null) => void // null = close the day panel
  onOpen: (t: Task) => void
  onMove: (t: Task, day: string) => void
  mode: CalMode
  onMode: (m: CalMode) => void
  range: { from: string; to: string } | null
  onRange: (r: { from: string; to: string }) => void
  holidays: Map<string, string[]>
  dayNotes: Record<string, DayNote>
}

export type CalMode = 'month' | 'week' | 'custom'
const MAX_RANGE = 92 // days

/** Put a range in order and keep it to a sensible length. */
function fixRange(from: string, to: string) {
  if (to < from) [from, to] = [to, from]
  if (daysBetween(from, to) > MAX_RANGE - 1) to = addDays(from, MAX_RANGE - 1)
  return { from, to }
}
const shortDate = (k: string, year = false) => {
  const d = fromKey(k)
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${year ? ` ${d.getFullYear()}` : ''}`
}

/**
 * Month or week grid. Each day shows its tasks as coloured chips (the list's
 * colour); drag a chip onto another day to reschedule it. Upcoming copies of
 * repeating tasks show as faded, dashed chips. Clicking a day opens its panel;
 * clicking the same day again closes it.
 */
export function CalendarView({ tasks, lists, weekStartsMonday, selected, onSelect, onOpen, onMove, mode, onMode, range: savedRange, onRange, holidays, dayNotes }: Props) {
  const [anchor, setAnchor] = useState(selected || todayKey())
  const [dragOver, setDragOver] = useState<string | null>(null)
  const today = todayKey()
  const byList = new Map(lists.map((l) => [l.id, l]))
  const first = weekStartsMonday ? 1 : 0

  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.due) continue
      if (!m.has(t.due)) m.set(t.due, [])
      m.get(t.due)!.push(t)
    }
    for (const list of m.values()) list.sort((a, b) => Number(a.done) - Number(b.done) || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority)
    return m
  }, [tasks])

  const startOfWeek = (k: string) => addDays(k, -((fromKey(k).getDay() - first + 7) % 7))
  const a = fromKey(anchor)
  const days: string[] = []
  // custom: the saved range, or the next 14 days
  const range = savedRange ? fixRange(savedRange.from, savedRange.to) : { from: today, to: addDays(today, 13) }
  const rangeLen = daysBetween(range.from, range.to) + 1
  const short = mode === 'custom' && rangeLen <= 7 // a few days side by side
  if (mode === 'custom') {
    if (short) for (let i = 0; i < rangeLen; i++) days.push(addDays(range.from, i))
    else {
      const start = startOfWeek(range.from)
      const end = addDays(startOfWeek(range.to), 6)
      for (let k = start; k <= end; k = addDays(k, 1)) days.push(k)
    }
  } else if (mode === 'month') {
    const start = startOfWeek(toKey(new Date(a.getFullYear(), a.getMonth(), 1)))
    for (let i = 0; i < 42; i++) days.push(addDays(start, i))
  } else {
    const start = startOfWeek(anchor)
    for (let i = 0; i < 7; i++) days.push(addDays(start, i))
  }
  const heading = mode === 'custom'
    ? fromKey(range.from).getFullYear() === fromKey(range.to).getFullYear()
      ? `${shortDate(range.from)} – ${shortDate(range.to, true)}`
      : `${shortDate(range.from, true)} – ${shortDate(range.to, true)}`
    : mode === 'month'
    ? `${MONTHS[a.getMonth()]} ${a.getFullYear()}`
    : (() => {
        const s = fromKey(days[0]), e = fromKey(days[6])
        return s.getMonth() === e.getMonth()
          ? `${s.getDate()}–${e.getDate()} ${MONTHS[s.getMonth()]} ${s.getFullYear()}`
          : `${s.getDate()} ${MONTHS[s.getMonth()].slice(0, 3)} – ${e.getDate()} ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getFullYear()}`
      })()

  // future occurrences of repeating tasks inside the visible range
  const ghosts = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.repeat || t.done || !t.due) continue
    for (const k of occurrencesBetween(t.due, t.repeat, days[0], days[days.length - 1], 45)) {
      if (!ghosts.has(k)) ghosts.set(k, [])
      ghosts.get(k)!.push(t)
    }
  }
  const pick = (d: string) => onSelect(d === selected ? null : d)

  const inRange = (d: string) => mode !== 'custom' || (d >= range.from && d <= range.to)
  const setRange = (from: string, to: string) => onRange(fixRange(from, to))
  const monthEnd = () => { const d = fromKey(today); return toKey(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }
  const monthStart = () => { const d = fromKey(today); return toKey(new Date(d.getFullYear(), d.getMonth(), 1)) }
  const presets = [
    { label: 'Next 7 days', from: today, to: addDays(today, 6) },
    { label: 'Next 14 days', from: today, to: addDays(today, 13) },
    { label: 'This month', from: monthStart(), to: monthEnd() },
    { label: 'Next 30 days', from: today, to: addDays(today, 29) },
  ]

  const step = (n: number) => {
    if (mode === 'custom') return setRange(addDays(range.from, rangeLen * n), addDays(range.to, rangeLen * n))
    if (mode === 'week') return setAnchor(addDays(anchor, 7 * n))
    setAnchor(toKey(new Date(a.getFullYear(), a.getMonth() + n, 1)))
  }
  const weekdays = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + first) % 7])

  const drop = (day: string) => (e: DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const t = tasks.find((x) => x.id === e.dataTransfer.getData('text/task-id'))
    if (t && t.due !== day) onMove(t, day)
  }

  const maxChips = mode === 'month' || (mode === 'custom' && !short) ? 3 : 12
  const unit = mode === 'month' ? 'month' : mode === 'week' ? 'week' : `${rangeLen} days`

  return (
    <div className="calendar">
      <div className="cal-bar">
        {/* moving through time: Today, back, forward, where you are */}
        <div className="row cal-nav">
          <button
            className="btn ghost sm"
            onClick={() => (mode === 'custom' ? setRange(today, addDays(today, rangeLen - 1)) : setAnchor(today))}
          >
            Today
          </button>
          <span className="cal-arrows">
            <button className="icon-btn" onClick={() => step(-1)} aria-label={`Previous ${unit}`}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" /></svg>
            </button>
            <button className="icon-btn" onClick={() => step(1)} aria-label={`Next ${unit}`}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" /></svg>
            </button>
          </span>
          <h2 className="cal-heading" aria-live="polite">{heading}</h2>
        </div>
        {/* how much you see */}
        <div className="row">
          <div className="seg" role="radiogroup" aria-label="Calendar view">
            {(['month', 'week', 'custom'] as CalMode[]).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => onMode(m)}>
                {m === 'month' ? 'Month' : m === 'week' ? 'Week' : 'Custom'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'custom' && (
        <div className="range-bar" role="group" aria-label="Custom range">
          <label className="range-field">
            <span>From</span>
            <input className="input sm" type="date" value={range.from} onChange={(e) => e.target.value && setRange(e.target.value, range.to < e.target.value ? e.target.value : range.to)} />
          </label>
          <span className="range-arrow" aria-hidden="true">→</span>
          <label className="range-field">
            <span>To</span>
            <input className="input sm" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange(range.from, e.target.value)} />
          </label>
          <span className="range-len">{rangeLen} day{rangeLen === 1 ? '' : 's'}</span>
          <div className="range-presets">
            {presets.map((p) => (
              <button key={p.label} className={`btn sm ${p.from === range.from && p.to === range.to ? '' : 'ghost'}`} onClick={() => setRange(p.from, p.to)}>{p.label}</button>
            ))}
          </div>
        </div>
      )}

      <div
        className={`cal-grid ${mode === 'custom' ? (short ? 'week custom short' : 'month custom') : mode}`}
        style={short ? ({ '--cols': rangeLen } as CSSProperties) : undefined}
        role="grid"
        aria-label={heading}
      >
        {(short ? days.map((d) => WEEKDAYS[fromKey(d).getDay()]) : weekdays).map((w, i) => <div key={`${w}${i}`} className="cal-dow" role="columnheader">{w}</div>)}
        {days.map((d) => {
          const list = byDay.get(d) || []
          const ghostList = ghosts.get(d) || []
          const date = fromKey(d)
          if (!inRange(d)) return <div key={d} className="cal-day out-range" aria-hidden="true"><span className="num">{date.getDate()}</span></div>
          const outside = mode === 'month' && date.getMonth() !== a.getMonth()
          const open = list.filter((t) => !t.done).length
          const hol = holidays.get(d)
          const note = dayNotes[d]
          const cls = ['cal-day', hol && 'holiday', outside && 'outside', d === today && 'today', d === selected && 'selected', d < today && 'past', dragOver === d && 'drop'].filter(Boolean).join(' ')
          return (
            <div
              key={d}
              data-date={d}
              className={cls}
              role="gridcell"
              aria-selected={d === selected}
              onClick={() => pick(d)}
              onDragOver={(e) => { e.preventDefault(); setDragOver(d) }}
              onDragLeave={() => setDragOver((x) => (x === d ? null : x))}
              onDrop={drop(d)}
            >
              <div className="cal-date-row">
                <button
                  className="cal-date"
                  onClick={(e) => { e.stopPropagation(); pick(d) }}
                  aria-pressed={d === selected}
                  aria-label={`${formatDay(d)}${hol ? `, ${hol.join(', ')}` : ''}${note?.label ? `, note: ${note.label}` : ''}, ${open} open task${open === 1 ? '' : 's'}`}
                >
                  {mode === 'week' && <span className="dow">{WEEKDAYS[date.getDay()]}</span>}
                  <span className="num">{date.getDate()}</span>
                </button>
                {note?.label && <span className={`day-label ${colorClass(note.color)}`} title={note.notes ? `${note.label}\n${note.notes}` : note.label}>{note.label}</span>}
                {note && !note.label && <span className={`day-dot ${colorClass(note.color)}`} title={note.notes} aria-hidden="true" />}
              </div>
              {hol && <span className="cal-holiday" title={hol.join(' · ')}>{hol.join(' · ')}</span>}
              <div className="cal-chips">
                {list.slice(0, maxChips).map((t) => {
                  const l = t.listId ? byList.get(t.listId) : undefined
                  return (
                    <button
                      key={t.id}
                      className={`cal-chip ${colorClass(l?.color)}${t.done ? ' done' : ''}${t.priority === 3 ? ' high' : ''}`}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)}
                      onClick={(e) => { e.stopPropagation(); onOpen(t) }}
                      title={`${t.title}${t.time ? ` · ${formatTime(t.time)}` : ''}${l ? ` · ${l.name}` : ''}`}
                    >
                      {t.time && <span className="t">{formatTime(t.time)}</span>}
                      <span className="n">{t.title}</span>
                    </button>
                  )
                })}
                {ghostList.slice(0, Math.max(0, maxChips - list.length)).map((t) => {
                  const l = t.listId ? byList.get(t.listId) : undefined
                  return (
                    <button
                      key={`g-${t.id}`}
                      className={`cal-chip ghost ${colorClass(l?.color)}`}
                      onClick={(e) => { e.stopPropagation(); onOpen(t) }}
                      title={`${t.title} (repeats)`}
                    >
                      {t.time && <span className="t">{formatTime(t.time)}</span>}
                      <span className="n">↻ {t.title}</span>
                    </button>
                  )
                })}
                {list.length + ghostList.length > maxChips && <span className="more">+{list.length + ghostList.length - maxChips} more</span>}
                {/* phones: a dot per task instead of chips */}
                {list.length + ghostList.length > 0 && (
                  <span className="cal-dots" aria-hidden="true">
                    {list.slice(0, 4).map((t) => <i key={t.id} className={`${colorClass((t.listId && byList.get(t.listId)?.color))}${t.done ? ' done' : ''}`} />)}
                    {ghostList.slice(0, Math.max(0, 4 - list.length)).map((t) => <i key={`g-${t.id}`} className={`ghost ${colorClass((t.listId && byList.get(t.listId)?.color))}`} />)}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
