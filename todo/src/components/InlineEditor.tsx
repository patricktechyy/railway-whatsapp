import { colorClass } from '../listColor'
import { defaultRemind } from '../prefs'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { formatDay, formatTime, todayKey } from '../dates'
import { describeRepeat } from '../repeat'
import type { List, Priority, Task, TaskInput } from '../types'
import { PRIORITY_LABEL } from './TaskItem'
import { MenuItem, Popover, usePopover } from './Popover'
import { ClockIcon, TimePicker } from './TimePicker'
import { CalendarIcon, DatePicker } from './DatePicker'
import { RepeatIcon, RepeatPicker } from './RepeatPicker'
import { BellIcon, Chip, FlagIcon, ListIcon } from './Chip'
import { AddLinkForm, LinkIcon } from './Links'
import { STATUSES, STATUS_LABEL, statusOf, type Status } from '../status'
import { describeRemind } from '../dates'
import { RemindPicker } from './RemindPicker'
import { WaIcon, WaPicker, describeWa } from './WaPicker'

interface Props {
  task: Task
  lists: List[]
  weekStartsMonday: boolean
  onChange: (patch: TaskInput) => void
  onStatus: (s: Status) => void
  onCollapse: () => void
  onDetails: () => void
  onNewList: () => void
  waOn?: boolean
}

const InfoIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6.2v.01" /></svg>

/** Edit a task right where it sits in the list: title, notes, tags and a row of chips. */
export function InlineEditor({ task, lists, weekStartsMonday, onChange, onStatus, onCollapse, onDetails, onNewList, waOn }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [tag, setTag] = useState('')
  const date = usePopover()
  const time = usePopover()
  const repeat = usePopover()
  const prio = usePopover()
  const list = usePopover()
  const stat = usePopover()
  const bell = usePopover()
  const linkPop = usePopover()
  const waPop = usePopover()

  useEffect(() => { setTitle(task.title) }, [task.title])
  useEffect(() => { setNotes(task.notes) }, [task.notes])

  // click anywhere else (except a popover or dialog) to fold it back up
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (box.current?.closest('li')?.contains(t) || t.closest('[data-popover], dialog')) return
      onCollapse()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onCollapse])

  const saveTitle = () => {
    const t = title.trim()
    if (!t) setTitle(task.title)
    else if (t !== task.title) onChange({ title: t })
  }
  const saveNotes = () => { if (notes !== task.notes) onChange({ notes }) }
  const addTag = (e: FormEvent) => {
    e.preventDefault()
    const t = tag.trim().replace(/^#/, '').toLowerCase()
    if (t && !task.tags.includes(t)) onChange({ tags: [...task.tags, t] })
    setTag('')
  }
  const escape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('[data-popover]')) { e.preventDefault(); (e.target as HTMLElement).blur(); onCollapse() }
  }

  const listObj = lists.find((l) => l.id === task.listId)
  const rep = task.repeat ?? null

  return (
    <div className="inline-editor" ref={box} onKeyDown={escape}>
      <input
        className="inline-title"
        value={title}
        maxLength={300}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); onCollapse() } }}
        aria-label="Title"
      />
      <textarea className="inline-notes" rows={1} value={notes} maxLength={5000} placeholder="Notes" onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} aria-label="Notes" />
      <div className="inline-tags">
        {task.tags.map((t) => (
          <span key={t} className="badge ok">
            #{t}
            <button type="button" className="x" aria-label={`Remove tag ${t}`} onClick={() => onChange({ tags: task.tags.filter((x) => x !== t) })}>×</button>
          </span>
        ))}
        <form onSubmit={addTag}>
          <input className="bare-input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add tags" maxLength={24} aria-label="Add a tag" />
        </form>
      </div>

      <div className="chip-row">
        <Chip icon={<span className={`status-dot st-${statusOf(task)}`} />} label={STATUS_LABEL[statusOf(task)]} title="Status" active={statusOf(task) !== 'todo'} onClick={stat.toggle} anchorRef={stat.ref} />
        <Chip icon={<CalendarIcon />} label={task.due ? formatDay(task.due) : undefined} title="Date" active={!!task.due} onClick={date.toggle} onClear={() => onChange({ due: null })} anchorRef={date.ref} />
        {task.due && (
          <Chip icon={<ClockIcon />} label={task.time ? formatTime(task.time, true) : undefined} title="Time" active={!!task.time} onClick={time.toggle} onClear={() => onChange({ time: null })} anchorRef={time.ref} />
        )}
        {task.due && (
          <Chip icon={<BellIcon />} label={task.remind !== null ? describeRemind(task.remind, { short: true }) : undefined} title="Reminder" active={task.remind !== null} onClick={bell.toggle} onClear={() => onChange({ remind: null })} anchorRef={bell.ref} />
        )}
        {waOn && <Chip icon={<WaIcon />} label={describeWa(task)} title="WhatsApp me" active={!!task.wa} onClick={waPop.toggle} onClear={() => onChange({ wa: null })} anchorRef={waPop.ref} />}
        <Chip icon={<RepeatIcon />} label={rep ? describeRepeat(rep) : undefined} title="Repeat" active={!!rep} onClick={repeat.toggle} onClear={() => onChange({ repeat: null })} anchorRef={repeat.ref} />
        <Chip icon={<FlagIcon />} label={task.priority ? PRIORITY_LABEL[task.priority] : undefined} title="Priority" active={task.priority > 0} onClick={prio.toggle} onClear={() => onChange({ priority: 0 })} anchorRef={prio.ref} />
        <Chip
          icon={listObj ? <i className={`swatch ${colorClass(listObj.color)}`} aria-hidden="true" /> : <ListIcon />}
          label={listObj ? listObj.name : undefined}
          title="List"
          active={!!listObj}
          onClick={list.toggle}
          anchorRef={list.ref}
        />
        <Chip icon={<LinkIcon />} label={(task.links || []).length ? `${task.links.length} link${task.links.length === 1 ? '' : 's'}` : undefined} title="Link" active={(task.links || []).length > 0} onClick={linkPop.toggle} anchorRef={linkPop.ref} />
        <span className="spacer" />
        <button type="button" className="icon-btn info" onClick={onDetails} aria-label="All details" title="All details"><InfoIcon /></button>
      </div>

      {date.open && <Popover anchor={date.anchor} onClose={date.close} label="Date"><DatePicker value={task.due} onPick={(d) => { onChange({ due: d }); date.close() }} /></Popover>}
      {time.open && <Popover anchor={time.anchor} onClose={time.close} label="Time"><TimePicker value={task.time} onPick={(t) => { onChange(t && task.remind === null && !task.time ? { time: t, remind: defaultRemind() } : { time: t }); time.close() }} /></Popover>}
      {linkPop.open && (
        <Popover anchor={linkPop.anchor} onClose={linkPop.close} label="Add a link" width={300}>
          <AddLinkForm onAdd={(l) => { if (!(task.links || []).some((x) => x.url === l.url)) onChange({ links: [...(task.links || []), l] }); linkPop.close() }} />
        </Popover>
      )}
      {waPop.open && (
        <Popover anchor={waPop.anchor} onClose={waPop.close} label="WhatsApp me" width={300}>
          <WaPicker task={task} onPick={(v) => { onChange({ wa: v }); waPop.close() }} />
        </Popover>
      )}
      {stat.open && (
        <Popover anchor={stat.anchor} onClose={stat.close} label="Status">
          <div className="menu" role="menu">
            {STATUSES.map((st) => (
              <MenuItem key={st} icon={<span className={`status-dot st-${st}`} />} label={STATUS_LABEL[st]} selected={statusOf(task) === st} onClick={() => { onStatus(st); stat.close() }} />
            ))}
          </div>
        </Popover>
      )}
      {bell.open && (
        <Popover anchor={bell.anchor} onClose={bell.close} label="Reminder">
          <RemindPicker value={task.remind} onPick={(v) => { onChange({ remind: v }); bell.close() }} />
        </Popover>
      )}
      {repeat.open && (
        <Popover anchor={repeat.anchor} onClose={repeat.close} label="Repeat" width={300}>
          <RepeatPicker value={rep} due={task.due} weekStartsMonday={weekStartsMonday} onPick={(r) => { onChange(task.due || !r ? { repeat: r } : { due: todayKey(), repeat: r }); repeat.close() }} />
        </Popover>
      )}
      {prio.open && (
        <Popover anchor={prio.anchor} onClose={prio.close} label="Priority">
          <div className="menu" role="menu">
            {([0, 1, 2, 3] as Priority[]).map((p) => (
              <MenuItem key={p} icon={p ? <span className={`prio p${p}`}>{'!'.repeat(p)}</span> : undefined} label={PRIORITY_LABEL[p]} selected={task.priority === p} onClick={() => { onChange({ priority: p }); prio.close() }} />
            ))}
          </div>
        </Popover>
      )}
      {list.open && (
        <Popover anchor={list.anchor} onClose={list.close} label="List">
          <div className="menu" role="menu">
            <MenuItem label="No list" selected={!task.listId} onClick={() => { onChange({ listId: null }); list.close() }} />
            {lists.map((l) => (
              <MenuItem key={l.id} icon={<i className={`swatch ${colorClass(l.color)}`} />} label={`${l.emoji} ${l.name}`} selected={task.listId === l.id} onClick={() => { onChange({ listId: l.id }); list.close() }} />
            ))}
            <div className="menu-sep" />
            <MenuItem label="+ New list…" onClick={() => { list.close(); onNewList() }} />
          </div>
        </Popover>
      )}
    </div>
  )
}
