import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Board, Widget, WidgetType } from '../types'
import { WIDGET_INFO, WidgetBody, type WidgetEnv } from '../components/widgets'
import { MenuItem, Popover, usePopover } from '../components/Popover'
import { Select } from '../components/Select'
import { Icon } from '../components/Icon'

const TYPES = Object.keys(WIDGET_INFO) as WidgetType[]
const newId = () => Math.random().toString(36).slice(2, 12)

/** The default board, same as the server's (used by "Reset board"). */
export const DEFAULT_WIDGETS: Omit<Widget, 'id'>[] = [
  { type: 'priority', title: '', size: 'lg', config: {} },
  { type: 'todo', title: '', size: 'md', config: {} },
  { type: 'stats', title: '', size: 'sm', config: {} },
  { type: 'today', title: '', size: 'md', config: {} },
  { type: 'doing', title: '', size: 'sm', config: {} },
  { type: 'notes', title: '', size: 'sm', config: { text: '', color: 'yellow' } },
]

const blank = (type: WidgetType, lists: WidgetEnv['lists'], title = ''): Widget => ({
  id: newId(), type, title, ...(type === 'priority' || type === 'status' ? { size: 'lg', w: 12 } : type === 'notes' || type === 'stats' ? { size: 'sm', w: 4 } : { size: 'md', w: 8 }), h: null, hidden: false,
  config: type === 'notes' ? { text: '', color: 'yellow' } : type === 'list' ? { listId: lists[0]?.id ?? null } : {},
})

const SIZE_W = { sm: 4, md: 8, lg: 12 } as const
const MIN_W = 3, MIN_H = 140, MAX_H = 1200
/** A block's width in columns (of 12). */
export const spanOf = (w: Widget) => w.w ?? SIZE_W[w.size] ?? 8
const sizeFor = (cols: number): Widget['size'] => (cols <= 5 ? 'sm' : cols <= 9 ? 'md' : 'lg')

/** The board's column metrics, for snapping widths to whole columns. */
function gridMetrics(el: HTMLElement) {
  const grid = el.parentElement!
  const cs = getComputedStyle(grid)
  const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1
  const gap = parseFloat(cs.columnGap) || 0
  return { cols, gap, colW: (grid.clientWidth - gap * (cols - 1)) / cols }
}

function Block({ widget, env, editing, onChange, onRemove }: {
  widget: Widget
  env: WidgetEnv
  editing: boolean
  onChange: (w: Widget) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id })
  const info = WIDGET_INFO[widget.type]
  const name = widget.title || info.name
  const box = useRef<HTMLElement | null>(null)
  const ghost = useRef<HTMLDivElement | null>(null)
  const hint = useRef<HTMLSpanElement | null>(null)
  const [resizing, setResizing] = useState(false)
  const span = spanOf(widget)
  const h = widget.h ?? null

  /**
   * Resizing follows the pointer pixel by pixel: the block's size is set
   * straight on the element each frame (no re-rendering), a dashed outline
   * shows the whole-column width it will land on, and when you let go it
   * glides there and is saved.
   */
  const startResize = (axis: 'x' | 'y' | 'xy') => (e: PointerEvent<HTMLDivElement>) => {
    const el = box.current
    if (e.button !== 0 || !el) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    const { cols, gap, colW } = gridMetrics(el)
    const canW = axis !== 'y' && cols >= 12 // phones: one column, height only
    const gridBox = el.parentElement!.getBoundingClientRect()
    const room = gridBox.right - r.left // how wide it can be where it is now
    const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height }
    let cur = { w: r.width, h: r.height }, snapCols = span, frame = 0
    const widthOf = (c: number) => c * colW + (c - 1) * gap
    setResizing(true)
    document.body.classList.add('resizing-board', axis)
    el.style.width = `${r.width}px`
    el.style.height = `${r.height}px`
    const paint = () => {
      frame = 0
      if (canW) {
        // no room on the right? it grows to the left (inside the board) while you drag
        el.style.width = `${cur.w}px`
        el.style.translate = cur.w > room ? `${-(cur.w - room)}px 0` : ''
      }
      if (axis !== 'x') el.style.height = `${cur.h}px`
      if (ghost.current) {
        ghost.current.style.width = `${canW ? Math.min(widthOf(snapCols), gridBox.width) : cur.w}px`
        ghost.current.style.height = `${cur.h}px`
      }
      if (hint.current) hint.current.textContent = `${canW ? `${snapCols} / 12 columns${widthOf(snapCols) > room + 1 ? ' (moves to the next row)' : ''}` : ''}${canW && axis !== 'x' ? ' · ' : ''}${axis !== 'x' ? `${Math.round(cur.h)}px tall` : ''}`
    }
    const move = (ev: globalThis.PointerEvent) => {
      if (canW) {
        cur.w = Math.max(widthOf(MIN_W), Math.min(gridBox.width, start.w + ev.clientX - start.x))
        snapCols = Math.max(MIN_W, Math.min(12, Math.round((cur.w + gap) / (colW + gap))))
      }
      if (axis !== 'x') cur.h = Math.max(MIN_H, Math.min(MAX_H, start.h + ev.clientY - start.y))
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      cancelAnimationFrame(frame)
      document.body.classList.remove('resizing-board', axis)
      const moved = Math.abs(cur.w - start.w) > 2 || Math.abs(cur.h - start.h) > 2
      const next: Widget = { ...widget }
      if (canW && moved) { next.w = snapCols; next.size = sizeFor(snapCols) }
      if (axis !== 'x' && moved) next.h = Math.round(cur.h)
      // glide to the snapped size, then hand the size back to the grid
      setResizing(false)
      el.classList.add('settling')
      if (canW) {
        el.style.translate = ''
        el.style.width = `${Math.min(widthOf(moved ? snapCols : span), room)}px`
      }
      const done = () => {
        el.classList.remove('settling')
        el.style.width = ''
        el.style.translate = ''
        // hand the height back to React (the saved one, or "fit")
        const hh = moved ? next.h : widget.h
        el.style.height = hh ? `${hh}px` : ''
        if (moved) onChange(next)
      }
      window.setTimeout(done, 230)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
    paint()
  }
  const keyResize = (axis: 'x' | 'y') => (e: KeyboardEvent<HTMLDivElement>) => {
    if (axis === 'x' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      const c = Math.max(MIN_W, Math.min(12, span + (e.key === 'ArrowRight' ? 1 : -1)))
      onChange({ ...widget, w: c, size: sizeFor(c) })
    }
    if (axis === 'y' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const cur = widget.h ?? box.current?.getBoundingClientRect().height ?? 300
      onChange({ ...widget, h: Math.round(Math.max(MIN_H, Math.min(MAX_H, cur + (e.key === 'ArrowDown' ? 20 : -20)))) })
    }
  }

  return (
    <section
      ref={(el) => { setNodeRef(el); box.current = el }}
      className={`widget wt-${widget.type}${h ? ' fixed-h' : ''}${isDragging ? ' dragging' : ''}${editing ? ' editing' : ''}${resizing ? ' resizing' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition: resizing ? undefined : transition, height: h ?? undefined, ['--span' as string]: span, ['--span-t' as string]: span > 6 ? 12 : 6 }}
      aria-label={name}
      data-widget={widget.type}
      data-widget-id={widget.id}
    >
      <header className="widget-head">
        <button type="button" className="widget-grip" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Move the ${name} block`} title="Drag to move">⠿</button>
        {editing
          ? <input className="input sm widget-rename" value={widget.title} placeholder={info.name} maxLength={40} onChange={(e) => onChange({ ...widget, title: e.target.value })} aria-label="Block name" />
          : <h3><Icon name={info.icon} />{name}</h3>}
        {editing && (
          <>
            <Select className="input sm" value={String(span)} onChange={(e) => { const c = Number(e.target.value); onChange({ ...widget, w: c, size: sizeFor(c) }) }} aria-label="Width">
              <option value="4">Narrow</option><option value="8">Medium</option><option value="12">Wide</option>
              {![4, 8, 12].includes(span) && <option value={span}>Custom ({span}/12)</option>}
            </Select>
            <button type="button" className="icon-btn sm" onClick={onRemove} aria-label={`Remove the ${name} block`} title="Remove">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
            </button>
          </>
        )}
      </header>
      {editing && widget.type === 'list' && (
        <Select className="input sm widget-list-pick" value={widget.config.listId || ''} onChange={(e) => onChange({ ...widget, config: { listId: e.target.value || null } })} aria-label="Which list">
          <option value="">Choose a list…</option>
          {env.lists.map((l) => <option key={l.id} value={l.id}>{l.emoji} {l.name}</option>)}
        </Select>
      )}
      <div className="widget-body">
        <WidgetBody widget={widget} env={env} onConfig={(config) => onChange({ ...widget, config })} />
      </div>
      {/* resize: right edge = width, bottom edge = height, corner = both; double-click resets */}
      <div className="widget-resize-x" role="separator" aria-orientation="vertical" aria-label={`Width of ${name}`} tabIndex={0} title="Drag to resize (double-click for medium)"
        onPointerDown={startResize('x')} onKeyDown={keyResize('x')} onDoubleClick={() => onChange({ ...widget, w: 8, size: 'md' })} />
      <div className="widget-resize-y" role="separator" aria-orientation="horizontal" aria-label={`Height of ${name}`} tabIndex={0} title="Drag to resize (double-click to fit)"
        onPointerDown={startResize('y')} onKeyDown={keyResize('y')} onDoubleClick={() => onChange({ ...widget, h: null })} />
      <div className="widget-resize-xy" aria-hidden="true" onPointerDown={startResize('xy')} onDoubleClick={() => onChange({ ...widget, h: null })} />
      {resizing && <div className="resize-ghost" ref={ghost} aria-hidden="true" />}
      {resizing && <span className="resize-hint" ref={hint} />}
    </section>
  )
}

/**
 * "Personalize It": your own page of blocks. Drag blocks by ⠿ to arrange
 * them, drag their edges to resize, and drag tasks between columns to change
 * their priority or status. Saved to your account, so every device matches.
 */
export function BoardView({ board, env, onSave }: { board: Board; env: WidgetEnv; onSave: (b: Board) => void }) {
  const [editing, setEditing] = useState(false)
  const add = usePopover()
  const blocks = usePopover()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const widgets = board.widgets
  const visible = widgets.filter((w) => !w.hidden)
  const full = widgets.length >= 20
  const save = (w: Widget[]) => onSave({ widgets: w })
  const end = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = widgets.map((w) => w.id)
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    save(arrayMove(widgets, from, to))
  }
  const addSticky = () => {
    const n = widgets.filter((w) => w.type === 'notes').length
    save([...widgets, blank('notes', env.lists, n ? `Sticky note ${n + 1}` : '')])
  }
  const addType = (t: WidgetType) => (t === 'notes' ? addSticky() : save([...widgets, blank(t, env.lists)]))
  const remove = (w: Widget) => {
    if (w.type === 'notes' && w.config.text?.trim() && !confirm(`Delete "${w.title || 'Sticky note'}" and its text?`)) return
    save(widgets.filter((x) => x.id !== w.id))
  }
  const reset = () => { if (confirm('Reset your board to the default?')) save(DEFAULT_WIDGETS.map((w) => ({ ...w, id: newId(), h: null, hidden: false }))) }
  const missing = TYPES.filter((t) => t !== 'notes' && !widgets.some((w) => w.type === t))

  return (
    <div className="board">
      <div className="board-bar">
        <span className="spacer" />
        <button className="btn ghost sm" onClick={addSticky} disabled={full} data-add-sticky>+ Sticky note</button>
        <button ref={blocks.ref} className="btn ghost sm" onClick={blocks.toggle} aria-haspopup="dialog" aria-expanded={blocks.open} data-blocks><Icon name="blocks" />Blocks</button>
        {editing && <button ref={add.ref} className="btn ghost sm" onClick={add.toggle} disabled={full}>+ Add block</button>}
        <button className={`btn sm${editing ? '' : ' ghost'}`} onClick={() => setEditing((e) => !e)} data-board-edit>{editing ? 'Done' : <><Icon name="pencil" />Edit board</>}</button>
      </div>

      {blocks.open && (
        <Popover anchor={blocks.anchor} onClose={blocks.close} label="Blocks on my board" width={300}>
          <div className="blocks-check">
            <p className="blocks-title">Show on my board</p>
            <ul>
              {widgets.map((w) => {
                const info = WIDGET_INFO[w.type]
                return (
                  <li key={w.id}>
                    <label className="toggle tight">
                      <input type="checkbox" checked={!w.hidden} onChange={(e) => save(widgets.map((x) => (x.id === w.id ? { ...x, hidden: !e.target.checked } : x)))} />
                      <span><Icon name={info.icon} />{w.title || info.name}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
            {missing.length > 0 && (
              <>
                <p className="blocks-title">Not on your board yet</p>
                <ul>
                  {missing.map((t) => (
                    <li key={t}>
                      <label className="toggle tight">
                        <input type="checkbox" checked={false} disabled={full} onChange={() => addType(t)} />
                        <span><Icon name={WIDGET_INFO[t].icon} />{WIDGET_INFO[t].name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="blocks-foot">
              <button type="button" className="btn quiet sm" onClick={addSticky} disabled={full}>+ Sticky note</button>
              <button type="button" className="btn quiet sm" onClick={() => save(widgets.map((w) => ({ ...w, hidden: false })))} disabled={!widgets.some((w) => w.hidden)}>Show all</button>
              <button type="button" className="btn quiet sm" onClick={() => { blocks.close(); reset() }}>Reset board</button>
            </div>
          </div>
        </Popover>
      )}
      {add.open && (
        <Popover anchor={add.anchor} onClose={add.close} label="Add a block" width={300}>
          <div className="menu" role="menu">
            {TYPES.map((t) => (
              <MenuItem key={t} icon={<Icon name={WIDGET_INFO[t].icon} />} label={WIDGET_INFO[t].name} sub={WIDGET_INFO[t].help} onClick={() => { add.close(); addType(t) }} />
            ))}
          </div>
        </Popover>
      )}

      {visible.length === 0 ? (
        <div className="empty">{widgets.length ? <>All your blocks are hidden. Turn some on in <b>Blocks</b>.</> : <>Your board is empty. Add something from <b>Blocks</b>.</>}</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
          <SortableContext items={visible.map((w) => w.id)} strategy={rectSortingStrategy}>
            <div className="board-grid">
              {visible.map((w) => (
                <Block
                  key={w.id}
                  widget={w}
                  env={env}
                  editing={editing}
                  onChange={(nw) => save(widgets.map((x) => (x.id === w.id ? nw : x)))}
                  onRemove={() => remove(w)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
