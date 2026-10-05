import { useState } from 'react'
import { fireTier } from '../stats'

/**
 * The streak flame at the top of Stats. Its colour steps up every two weeks
 * (red → orange → yellow → green → blue → purple). Hover or focus it to see
 * the streak; the same text is its accessible label.
 */
export function Fire({ days }: { days: number }) {
  const [tip, setTip] = useState(false)
  const t = fireTier(days)
  const text = days < 1
    ? 'No streak yet. Finish a task today to start one.'
    : `🔥 ${days}-day streak${t.next ? ` · ${t.next.in} more day${t.next.in === 1 ? '' : 's'} to ${t.next.name}` : ' · max level'}`
  return (
    <span
      className={`fire fire-${t.level}`}
      tabIndex={0}
      role="img"
      aria-label={text}
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
      onFocus={() => setTip(true)}
      onBlur={() => setTip(false)}
    >
      <svg viewBox="0 0 32 40" aria-hidden="true">
        <path className="outer" d="M16 1.5c1.2 6.3-2.6 9.6-5.7 13.3C7.3 18.4 4 22.2 4 27.6 4 34.2 9.4 38.5 16 38.5s12-4.3 12-10.9c0-4.9-2.4-8.4-4.6-11.4-.4 2.8-1.8 4.6-3.6 5.4.7-7.6-1.4-14.5-3.8-19.6z" />
        <path className="inner" d="M16 20.5c.5 3-1.2 4.5-2.6 6.1-1.3 1.5-2.4 3-2.4 5.1 0 3 2.3 4.8 5 4.8s5-1.8 5-4.8c0-2.4-1.1-4-2.2-5.4-.3 1.2-.9 1.9-1.7 2.2.3-3.2-.3-5.8-1.1-8z" />
      </svg>
      {days > 0 && <b className="fire-count" aria-hidden="true">{days}</b>}
      {tip && <span className="fire-tip" role="tooltip">{text}</span>}
    </span>
  )
}
