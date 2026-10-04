import { colorClass } from '../listColor'
import { useState } from 'react'
import { WEEKDAYS, addDays, dueAt, formatDue, fromKey, isOverdue, todayKey, toKey } from '../dates'
import type { List, Task } from '../types'
import { PRIORITY_LABEL } from '../components/TaskItem'
import { StatusBar } from '../components/StatusBar'

const OVERDUE_PREVIEW = 5

interface Props {
  tasks: Task[]
  lists: List[]
  onOpen: (t: Task) => void
  overdueShowAll: boolean
  onOverdueShowAll: (on: boolean) => void
  onShowTodo: () => void
  onShowOverdue: () => void
}

/** "2 hours late", "3 days late" */
function lateBy(t: Task) {
  const ms = Date.now() - (dueAt(t) as number)
  const h = Math.floor(ms / 36e5)
  if (h < 1) return 'Just now'
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} late`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} late`
}

interface Bar { key: string; label: string; full: string; value: number }

/**
 * One-series column chart: a leaf column per day, 4px rounded top, clean
 * y ticks, a hover tooltip per column and a table view for screen readers.
 */
function Columns({ title, sub, bars, unit, highlight }: { title: string; sub: string; bars: Bar[]; unit: string; highlight?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const W = 640, H = 200, padL = 28, padB = 26, padT = 12
  const max = Math.max(1, ...bars.map((b) => b.value))
  const stepV = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5)
  const top = Math.ceil(max / stepV) * stepV
  const ticks = Array.from({ length: top / stepV + 1 }, (_, i) => i * stepV)
  const band = (W - padL) / bars.length
  const bw = Math.min(24, band - 6)
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top)

  return (
    <section className="card chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          <p className="help">{sub}</p>
        </div>
        <button className="btn quiet sm" onClick={() => setTable(!table)} aria-pressed={table}>{table ? 'Show chart' : 'Show table'}</button>
      </div>
      {table ? (
        <table className="data-table">
          <thead><tr><th>Day</th><th>{unit}</th></tr></thead>
          <tbody>{bars.map((b) => <tr key={b.key}><td>{b.full}</td><td>{b.value}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="chart-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${title}: ${bars.map((b) => `${b.full} ${b.value}`).join(', ')}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="grid" />
                <text x={padL - 8} y={y(t) + 4} className="tick" textAnchor="end">{t}</text>
              </g>
            ))}
            {bars.map((b, i) => {
              const x = padL + band * i + (band - bw) / 2
              const h = y(0) - y(b.value)
              const r = Math.min(4, h)
              return (
                <g key={b.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  {/* hit target is the whole band, not just the column */}
                  <rect x={padL + band * i} y={padT} width={band} height={H - padT - padB} fill="transparent" />
                  {b.value > 0 && (
                    <path
                      className={`col${hover === i ? ' hot' : ''}`}
                      d={`M${x},${y(0)} V${y(b.value) + r} Q${x},${y(b.value)} ${x + r},${y(b.value)} H${x + bw - r} Q${x + bw},${y(b.value)} ${x + bw},${y(b.value) + r} V${y(0)} Z`}
                    />
                  )}
                  <text x={padL + band * i + band / 2} y={H - 8} className={`tick${b.key === highlight ? ' strong' : ''}`} textAnchor="middle">{b.label}</text>
                </g>
              )
            })}
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: `${((padL + band * hover + band / 2) / W) * 100}%`, top: `${(y(bars[hover].value) / H) * 100}%` }}>
              <b>{bars[hover].value}</b> {unit.toLowerCase()}
              <span>{bars[hover].full}</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Tile({ label, value, note, tone, onClick, go }: { label: string; value: string | number; note?: string; tone?: 'danger' | 'ok'; onClick?: () => void; go?: string }) {
  const cls = `tile${tone ? ` ${tone}` : ''}${onClick ? ' link' : ''}`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} title={go} data-tour={label.toLowerCase().replace(/\s+/g, '-')}>
        <span className="tile-label">{label} <span className="tile-go" aria-hidden="true">→</span></span>
        <span className="tile-value">{value}</span>
        {note && <span className="tile-note">{note}</span>}
        {go && <span className="sr-only">{go}</span>}
      </button>
    )
  }
  return (
    <div className={cls}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  )
}

export function StatsView({ tasks, lists, onOpen, overdueShowAll, onOverdueShowAll, onShowTodo, onShowOverdue }: Props) {
  const today = todayKey()
  const doneDay = (t: Task) => (t.doneAt ? toKey(new Date(t.doneAt)) : null)
  const doneCount = new Map<string, number>()
  for (const t of tasks) {
    const d = t.done && doneDay(t)
    if (d) doneCount.set(d, (doneCount.get(d) || 0) + 1)
  }


  const last7 = Array.from({ length: 7 }, (_, i) => addDays(today, -i))
  const weekDone = last7.reduce((n, d) => n + (doneCount.get(d) || 0), 0)
  const open = tasks.filter((t) => !t.done)
  const overdue = open.filter(isOverdue).sort((a, b) => (dueAt(a) as number) - (dueAt(b) as number))
  const byList = new Map(lists.map((l) => [l.id, l]))
  const dueToday = tasks.filter((t) => t.due === today)
  const dueTodayDone = dueToday.filter((t) => t.done).length

  const short = (k: string) => { const d = fromKey(k); return `${d.getDate()}` }
  const full = (k: string) => { const d = fromKey(k); return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}` }

  const past: Bar[] = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13)).map((k) => ({ key: k, label: short(k), full: full(k), value: doneCount.get(k) || 0 }))
  const ahead: Bar[] = Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((k) => ({
    key: k, label: short(k), full: full(k), value: open.filter((t) => t.due === k).length,
  }))

  const perList = [...lists.map((l) => ({ id: l.id, name: `${l.emoji} ${l.name}`, color: l.color as string })), { id: null as string | null, name: 'No list', color: 'none' }]
    .map((l) => {
      const all = tasks.filter((t) => t.listId === l.id)
      return { ...l, total: all.length, done: all.filter((t) => t.done).length }
    })
    .filter((l) => l.total > 0)

  return (
    <div className="stats">
      <div className="stats-top">
        <div className="tiles">
          <Tile label="Done today" value={doneCount.get(today) || 0} note={dueToday.length ? `${dueTodayDone} of ${dueToday.length} due today` : 'Nothing due today'} tone="ok" />
          <Tile label="Done this week" value={weekDone} note="Last 7 days" />
          <Tile label="Still to do" onClick={onShowTodo} go="Show these tasks" value={open.length} note={open.length ? 'Open tasks' : 'All clear ✨'} />
          <Tile label="Overdue" onClick={onShowOverdue} go="Show overdue tasks" value={overdue.length} note={overdue.length ? `Oldest: ${lateBy(overdue[0])}` : 'Nothing overdue 🎉'} tone={overdue.length ? 'danger' : 'ok'} />
        </div>
      </div>
      <aside className="stats-side">
        <section className="card">
          <h2>Progress by list</h2>
          <p className="help">Done out of all tasks in each list</p>
          {perList.length === 0 ? <p className="muted">No tasks yet.</p> : (
            <ul className="progress-list">
              {perList.map((l) => (
                <li key={String(l.id)}>
                  <div className="progress-top">
                    <span className="progress-name"><i className={`swatch ${colorClass(l.color)}`} aria-hidden="true" />{l.name}</span>
                    <span className="progress-num">{l.done}/{l.total}</span>
                  </div>
                  <div className="meter-bar" role="progressbar" aria-label={l.name} aria-valuemin={0} aria-valuemax={l.total} aria-valuenow={l.done}>
                    <span className={`${colorClass(l.color)}`} style={{ width: `${(l.done / l.total) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Open by priority</h2>
          <p className="help">What's still waiting</p>
          <ul className="prio-list">
            {[3, 2, 1, 0].map((p) => {
              const n = open.filter((t) => t.priority === p).length
              return (
                <li key={p}>
                  <span className={`meta prio p${p}`}>
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5h8l-1.8 3 1.8 3h-8" /></svg>
                    {p ? PRIORITY_LABEL[p] : 'No priority'}
                  </span>
                  <b>{n}</b>
                </li>
              )
            })}
          </ul>
        </section>
        <section className="card">
          <h2>Status</h2>
          <p className="help">All tasks, by where they're at</p>
          <StatusBar tasks={tasks} label="All tasks" />
        </section>
      </aside>
      <div className="stats-main">
        <section className="card overdue-card">
          <div className="chart-head">
            <div>
              <h2>Overdue</h2>
              <p className="help">{overdue.length ? 'Most late first. Click one to open it.' : 'Past their due date and not done yet'}</p>
            </div>
            {overdue.length > 0 && <span className="badge danger"><i className="dot" />{overdue.length}</span>}
          </div>
          {overdue.length === 0 ? (
            <p className="muted">Nothing overdue 🎉 You're on top of it.</p>
          ) : (
            <ul className="overdue-list">
              {(overdueShowAll ? overdue : overdue.slice(0, OVERDUE_PREVIEW)).map((t) => {
                const l = t.listId ? byList.get(t.listId) : undefined
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => onOpen(t)}>
                      <span className="od-main">
                        <span className="od-title">{t.title}</span>
                        <span className="od-meta">
                          <span className="list-chip"><i className={`swatch ${colorClass(l?.color)}`} aria-hidden="true" />{l ? `${l.emoji} ${l.name}` : 'No list'}</span>
                          <span>Due {formatDue(t)}</span>
                          {t.priority > 0 && <span className={`prio p${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>}
                        </span>
                      </span>
                      <span className="od-late">{lateBy(t)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {overdue.length > OVERDUE_PREVIEW && (
            <button className="btn ghost sm show-all" onClick={() => onOverdueShowAll(!overdueShowAll)} aria-expanded={overdueShowAll}>
              {overdueShowAll ? 'Show less' : `Show all (${overdue.length})`}
            </button>
          )}
        </section>
        <Columns title="Tasks completed" sub="Per day, last 14 days" unit="Completed" bars={past} highlight={today} />
        <Columns title="Coming up" sub="Open tasks due each day, next 14 days" unit="Due" bars={ahead} highlight={today} />
      </div>
    </div>
  )
}
