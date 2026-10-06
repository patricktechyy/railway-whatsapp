import { useState } from 'react'
import { STATUSES, STATUS_LABEL, statusOf, type Status } from '../status'
import type { Task } from '../types'

/**
 * One stacked bar for a page: how many tasks are not started (red),
 * in progress (yellow) and completed (green). Counts are written out
 * underneath, so the colours are never the only way to read it.
 */
export function StatusBar({ tasks, label = 'Progress' }: { tasks: Task[]; label?: string }) {
  const [hover, setHover] = useState<Status | null>(null)
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>
  for (const t of tasks) counts[statusOf(t)]++
  const total = tasks.length
  if (!total) return null
  const pct = Math.round((counts.done / total) * 100)
  return (
    <div className="status-bar" aria-label={`${label}: ${STATUSES.map((s) => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(', ')}`} role="group">
      <div className="status-track" onMouseLeave={() => setHover(null)}>
        {STATUSES.map((s) => counts[s] > 0 && (
          <span
            key={s}
            className={`seg-${s}${hover && hover !== s ? ' dim' : ''}`}
            style={{ flexGrow: counts[s] }}
            onMouseEnter={() => setHover(s)}
          >
            {hover === s && (
              <span className="status-tip" role="tooltip">
                <b>{counts[s]}</b> {STATUS_LABEL[s].toLowerCase()} · {Math.round((counts[s] / total) * 100)}%
              </span>
            )}
          </span>
        ))}
      </div>
      <div className="status-legend">
        {STATUSES.map((s) => (
          <span key={s} className={`legend-item${hover === s ? ' hot' : ''}`} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)}>
            <i className={`key seg-${s}`} aria-hidden="true" />
            <b>{counts[s]}</b> {STATUS_LABEL[s].toLowerCase()}
          </span>
        ))}
        <span className="legend-total">{pct}% done</span>
      </div>
    </div>
  )
}
