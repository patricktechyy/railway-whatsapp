import { useRef, useState, type KeyboardEvent } from 'react'
import { formatTime, pad } from '../dates'

/**
 * Hours and minutes as two separate boxes, so you can change just the
 * minutes. Digits only; hour 0–23, minute 0–59; padded to 00 on blur.
 * ↑/↓ step the value (minutes wrap and carry into the hour).
 */
export function TimeInput({ value, onSubmit }: { value: string | null; onSubmit: (t: string) => void }) {
  const [h0, m0] = (value || '08:00').split(':')
  const [hour, setHour] = useState(h0)
  const [minute, setMinute] = useState(m0)
  const minRef = useRef<HTMLInputElement>(null)

  const hNum = hour === '' ? NaN : Number(hour)
  const mNum = minute === '' ? NaN : Number(minute)
  const hourOk = Number.isInteger(hNum) && hNum >= 0 && hNum <= 23
  const minOk = Number.isInteger(mNum) && mNum >= 0 && mNum <= 59
  const valid = hourOk && minOk
  const time = valid ? `${pad(hNum)}:${pad(mNum)}` : null
  const error = !hourOk ? 'Hour must be 00–23' : !minOk ? 'Minutes must be 00–59' : ''

  // after React has committed the hour, so the hour's blur tidy-up sees the new value
  const jumpToMinutes = () => setTimeout(() => minRef.current?.focus(), 0)
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 2)
  const setBoth = (h: number, m: number) => {
    const total = (((h * 60 + m) % 1440) + 1440) % 1440
    setHour(pad(Math.floor(total / 60)))
    setMinute(pad(total % 60))
  }
  /**
   * Typing a digit: a full (or fully selected) box starts over with that digit,
   * otherwise it's appended. An hour that can't take a second digit (3–9), or a
   * complete valid hour, moves on to the minutes, like a phone's time field.
   */
  const typeDigit = (field: 'h' | 'm', e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    const cur = el.value
    const all = el.selectionStart === 0 && el.selectionEnd === cur.length
    let next = all || cur.length >= 2 ? e.key : cur + e.key
    if (field === 'h') {
      if (next.length === 1 && Number(next) > 2) next = pad(Number(next))
      setHour(next)
      if (next.length === 2 && Number(next) <= 23) jumpToMinutes()
    } else {
      if (next.length === 1 && Number(next) > 5) next = pad(Number(next))
      setMinute(next)
    }
  }

  const step = (field: 'h' | 'm') => (e: KeyboardEvent<HTMLInputElement>) => {
    if (/^\d$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      typeDigit(field, e)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (time) onSubmit(time)
      return
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const d = e.key === 'ArrowUp' ? 1 : -1
    const h = hourOk ? hNum : 0, m = minOk ? mNum : 0
    if (field === 'h') setHour(pad((h + d + 24) % 24))
    else setBoth(h, m + d)
  }

  return (
    <div className="time-input">
      <div className="time-fields" role="group" aria-label="Custom time">
        <input
          className={`input sm tnum${hourOk ? '' : ' bad'}`}
          inputMode="numeric"
          value={hour}
          aria-label="Hour (0 to 23)"
          aria-invalid={!hourOk}
          onFocus={(e) => e.target.select()}
          onMouseUp={(e) => e.preventDefault()} // keep the select-all from focus, so typing replaces
          onChange={(e) => {
            const v = digits(e.target.value)
            setHour(v)
            if (v.length === 2 && Number(v) <= 23) jumpToMinutes() // typed a valid hour: on to minutes
          }}
          onBlur={(e) => { const v = e.target.value; if (v !== '' && Number(v) <= 23) setHour(pad(Number(v))) }}
          onKeyDown={step('h')}
          autoFocus
        />
        <span className="colon">:</span>
        <input
          ref={minRef}
          className={`input sm tnum${minOk ? '' : ' bad'}`}
          inputMode="numeric"
          value={minute}
          aria-label="Minutes (0 to 59)"
          aria-invalid={!minOk}
          onFocus={(e) => e.target.select()}
          onMouseUp={(e) => e.preventDefault()}
          onChange={(e) => setMinute(digits(e.target.value))}
          onBlur={(e) => { const v = e.target.value; if (v !== '' && Number(v) <= 59) setMinute(pad(Number(v))) }}
          onKeyDown={step('m')}
        />
        <button type="button" className="btn sm" disabled={!valid} onClick={() => time && onSubmit(time)}>Set</button>
      </div>
      <p className={`help time-hint${error ? ' bad' : ''}`} role={error ? 'alert' : undefined}>
        {error || (time ? `= ${formatTime(time, true)}` : '')}
      </p>
    </div>
  )
}
