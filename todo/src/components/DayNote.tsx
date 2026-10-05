import { useEffect, useState } from 'react'
import { LIST_COLORS, type DayNote as Note, type ListColor } from '../types'

/**
 * Your own note on a day: a short label (shown next to the date on the
 * calendar), longer details, and a colour. Saves when you leave a field.
 */
export function DayNote({ date, note, onSave, onDelete }: {
  date: string
  note?: Note
  onSave: (n: { label: string; notes: string; color: ListColor }) => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(note?.label || '')
  const [notes, setNotes] = useState(note?.notes || '')
  const [color, setColor] = useState<ListColor>(note?.color || 'blue')
  const [open, setOpen] = useState(!!note)

  // another day picked, or changed on another device
  useEffect(() => {
    setLabel(note?.label || '')
    setNotes(note?.notes || '')
    setColor(note?.color || 'blue')
    setOpen(!!note)
  }, [date, note?.label, note?.notes, note?.color])

  const save = (patch: Partial<{ label: string; notes: string; color: ListColor }> = {}) => {
    const next = { label: label.trim(), notes: notes.trim(), color, ...patch }
    if (next.label === (note?.label || '') && next.notes === (note?.notes || '') && next.color === (note?.color || 'blue')) return
    if (!next.label && !next.notes) { if (note) onDelete(); return }
    onSave(next)
  }

  if (!open) {
    return (
      <button type="button" className="day-note-add" onClick={() => setOpen(true)}>
        <span aria-hidden="true">✎</span> Add a note for this day
      </button>
    )
  }
  return (
    <div className={`day-note c-${color}`}>
      <div className="day-note-head">
        <input
          className="day-note-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => save()}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="Label, like Mum’s birthday"
          maxLength={40}
          aria-label="Day label"
          autoFocus={!note}
        />
        {note && (
          <button type="button" className="icon-btn sm" aria-label="Delete this day’s note" title="Delete note" onClick={() => { onDelete(); setOpen(false) }}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10" /></svg>
          </button>
        )}
      </div>
      <textarea className="day-note-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => save()} placeholder="Details (optional)" maxLength={1000} aria-label="Day details" />
      <div className="day-note-colors" role="radiogroup" aria-label="Colour">
        {LIST_COLORS.map((c) => (
          <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} className={`c-${c}${color === c ? ' on' : ''}`} onClick={() => { setColor(c); save({ color: c }) }} />
        ))}
      </div>
    </div>
  )
}
