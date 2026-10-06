import { useEffect, useRef, useState } from 'react'

const SearchIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4" /></svg>

/**
 * Search in the page header. On wide screens it's a box; on phones it's a
 * magnifier that opens a full-width box (so the title isn't pushed down by
 * a search field you mostly don't use). It stays open while it has text.
 */
export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const shown = open || !!value
  useEffect(() => { if (open) input.current?.focus() }, [open])
  return (
    <>
      <button type="button" className={`icon-btn search-toggle${shown ? ' on' : ''}`} aria-label="Search" aria-expanded={shown} onClick={() => (shown && !value ? setOpen(false) : setOpen(true))}>
        <SearchIcon />
      </button>
      <label className={`search${shown ? ' open' : ''}`}>
        <SearchIcon />
        <input
          ref={input}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => { if (!value) setOpen(false) }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onChange(''); (e.target as HTMLInputElement).blur() } }}
          placeholder="Search tasks"
          aria-label="Search tasks"
          data-search
        />
      </label>
    </>
  )
}
