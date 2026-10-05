import { colorClass } from '../listColor'
import { defaultRemind } from '../prefs'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { formatDay, formatTime, todayKey } from '../dates'
import { parseQuickAdd } from '../quickadd'
import { describeRepeat } from '../repeat'
import type { List, Priority, Repeat, TaskInput } from '../types'
import { PRIORITY_LABEL } from './TaskItem'
import { MenuItem, Popover, usePopover } from './Popover'
import { ClockIcon, TimePicker } from './TimePicker'
import { CalendarIcon, DatePicker } from './DatePicker'
import { RepeatIcon, RepeatPicker } from './RepeatPicker'
import { BellIcon, Chip, FlagIcon, ListIcon } from './Chip'
import { AddLinkForm, ExtLink, LinkIcon } from './Links'
import type { TaskLink } from '../types'
import { STATUSES, STATUS_LABEL, type Status } from '../status'
import { describeRemind } from '../dates'
import { RemindPicker } from './RemindPicker'
import { WaIcon, WaPicker, describeWa } from './WaPicker'
import type { WaRemind } from '../types'

interface Props {
  lists: List[]
  defaults: TaskInput // the list / day / tag you're looking at
  placeholder?: string
  weekStartsMonday: boolean
  onAdd: (t: TaskInput & { title: string }) => void
  onNewList: () => void
  waOn?: boolean // show "💬 WhatsApp me"
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** The fields a new task can have, with `undefined` meaning "not chosen by hand". */
type Manual = { due?: string | null; time?: string | null; repeat?: Repeat | null; priority?: Priority; listId?: string | null; remind?: number | null; status?: Status; wa?: WaRemind | null }

/** Why the task can't be added yet, or '' if it can. */
export function validate(t: { title: string; due: string | null; time: string | null; repeat: Repeat | null }) {
  const title = t.title.trim()
  if (!title) return 'Give the task a title'
  if (title.length > 300) return 'Title is too long (300 characters max)'
  if (t.time && !TIME_RE.test(t.time)) return 'Time must be between 00:00 and 23:59'
  if (t.time && !t.due) return 'A time needs a date'
  if (t.repeat?.until && t.due && t.repeat.until < t.due) return 'Repeat can’t end before the task starts'
  return ''
}

/**
 * "+ Add a task…" that opens into a Reminders-style form. The form starts
 * empty every time it opens (and again after each Add); notes stay hidden
 * until you ask for them; Add only works when the task is valid.
 */
export function NewTaskForm(props: Props) {
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0) // bump to mount a fresh, empty form

  if (!open) {
    return (
      <button type="button" className="new-task-trigger" onClick={() => { setRound((r) => r + 1); setOpen(true) }} data-quick-add>
        <span className="plus" aria-hidden="true">+</span>
        <span>{props.placeholder || 'Add a task…'}</span>
      </button>
    )
  }
  return (
    <Form
      key={round}
      {...props}
      onAdded={() => setRound((r) => r + 1)}
      onClose={() => setOpen(false)}
    />
  )
}

function Form({ lists, defaults, weekStartsMonday, onAdd, onNewList, onAdded, onClose, waOn }: Props & { onAdded: () => void; onClose: () => void }) {
  const box = useRef<HTMLFormElement>(null)
  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')
  const [showNotes, setShowNotes] = useState(false)
  const [tags, setTags] = useState<string[]>(defaults.tags || [])
  const [tagText, setTagText] = useState('')
  const [links, setLinks] = useState<TaskLink[]>([])
  const [manual, setManual] = useState<Manual>({})
  const [tried, setTried] = useState(false)
  const date = usePopover()
  const time = usePopover()
  const repeat = usePopover()
  const prio = usePopover()
  const list = usePopover()
  const bell = usePopover()
  const linkPop = usePopover()
  const stat = usePopover()
  const waPop = usePopover()

  // typed shortcuts ("tomorrow 4pm !3 #exam @School every mon") fill the chips live;
  // anything chosen by hand wins over what was typed
  const parsed = parseQuickAdd(text, lists)
  const pick = <K extends keyof Manual>(k: K, fallback: Manual[K]): Manual[K] => (k in manual ? manual[k] : fallback)
  const time_ = pick('time', parsed.time ?? defaults.time ?? null) ?? null
  let due = pick('due', parsed.due ?? defaults.due ?? null) ?? null
  if (time_ && !due) due = todayKey()
  const rep = pick('repeat', parsed.repeat ?? defaults.repeat ?? null) ?? null
  if (rep && !due) due = todayKey()
  const priority = pick('priority', parsed.priority ?? defaults.priority ?? 0) ?? 0
  const listId = pick('listId', parsed.listId ?? defaults.listId ?? null) ?? null
  const allTags = [...new Set([...tags, ...(parsed.tags || [])])]
  const allLinks = [...links, ...(parsed.links || []).filter((l) => !links.some((x) => x.url === l.url))]
  const listObj = lists.find((l) => l.id === listId)
  // like Reminders: a task with a time alerts at that time unless you say otherwise
  const remind = due ? (pick('remind', time_ ? defaultRemind() : null) ?? null) : null
  const status = pick('status', 'todo') ?? 'todo'
  const wa = pick('wa', null) ?? null

  const error = validate({ title: parsed.title, due, time: time_, repeat: rep })
  const set = (patch: Manual) => setManual((m) => ({ ...m, ...patch }))

  // clicking elsewhere closes the form if nothing has been typed
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (box.current?.contains(t) || t.closest('[data-popover], dialog')) return
      if (!text.trim() && !notes.trim()) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [text, notes, onClose])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    setTried(true)
    if (error) return
    onAdd({
      title: parsed.title.trim(),
      notes: notes.trim(),
      due, time: due ? time_ : null, repeat: rep,
      remind, priority, listId, tags: allTags, status, links: allLinks,
      ...(wa ? { wa } : {}),
    })
    onAdded() // remounts an empty form for the next one
  }
  const addTag = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault()
    e.stopPropagation()
    const t = tagText.trim().replace(/^#/, '').toLowerCase().slice(0, 24)
    if (t && !tags.includes(t)) setTags([...tags, t])
    setTagText('')
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('[data-popover]')) { e.preventDefault(); onClose() }
  }

  return (
    <form className="new-task" ref={box} onSubmit={submit} onKeyDown={onKey} aria-label="New task" noValidate>
      <div className="new-task-main">
        <span className="check ghost" aria-hidden="true" />
        <div className="new-task-fields">
          <input
            className="inline-title"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="New task"
            maxLength={400}
            autoFocus
            aria-label="Title"
            aria-invalid={tried && !!error}
            data-quick-add
          />
          {showNotes ? (
            <textarea className="inline-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" maxLength={5000} aria-label="Notes" autoFocus />
          ) : (
            <button type="button" className="linkish add-note" onClick={() => setShowNotes(true)}>+ Add note</button>
          )}
          <div className="inline-tags">
            {allTags.map((t) => (
              <span key={t} className="badge ok">
                #{t}
                {tags.includes(t) && <button type="button" className="x" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>×</button>}
              </span>
            ))}
            <input
              className="bare-input"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTag(e) }}
              placeholder="Add tags"
              maxLength={25}
              aria-label="Add a tag"
            />
          </div>

          {allLinks.length > 0 && (
            <div className="task-links">
              {allLinks.map((l) => (
                <span key={l.url} className="link-edit">
                  <ExtLink link={l} />
                  {links.some((x) => x.url === l.url) && <button type="button" className="x" aria-label="Remove link" onClick={() => setLinks(links.filter((x) => x.url !== l.url))}>×</button>}
                </span>
              ))}
            </div>
          )}
          <div className="chip-row">
            <Chip icon={<span className={`status-dot st-${status}`} />} label={STATUS_LABEL[status]} title="Status" active={status !== 'todo'} onClick={stat.toggle} anchorRef={stat.ref} />
            <Chip icon={<CalendarIcon />} label={due ? formatDay(due) : undefined} title="Date" active={!!due} onClick={date.toggle} onClear={() => set({ due: null, time: null, repeat: null })} anchorRef={date.ref} />
            <Chip icon={<ClockIcon />} label={time_ ? formatTime(time_, true) : undefined} title="Time" active={!!time_} onClick={time.toggle} onClear={() => set({ time: null })} anchorRef={time.ref} />
            {due && (
              <Chip icon={<BellIcon />} label={remind !== null ? describeRemind(remind, { short: true }) : undefined} title="Reminder" active={remind !== null} onClick={bell.toggle} onClear={() => set({ remind: null })} anchorRef={bell.ref} />
            )}
            {waOn && <Chip icon={<WaIcon />} label={describeWa({ due, time: time_, wa })} title="WhatsApp me" active={!!wa} onClick={waPop.toggle} onClear={() => set({ wa: null })} anchorRef={waPop.ref} />}
            <Chip icon={<RepeatIcon />} label={rep ? describeRepeat(rep) : undefined} title="Repeat" active={!!rep} onClick={repeat.toggle} onClear={() => set({ repeat: null })} anchorRef={repeat.ref} />
            <Chip icon={<FlagIcon />} label={priority ? PRIORITY_LABEL[priority] : undefined} title="Priority" active={priority > 0} onClick={prio.toggle} onClear={() => set({ priority: 0 })} anchorRef={prio.ref} />
            <Chip icon={<LinkIcon />} title="Link" active={false} onClick={linkPop.toggle} anchorRef={linkPop.ref} />
            <Chip
              icon={listObj ? <i className={`swatch ${colorClass(listObj.color)}`} aria-hidden="true" /> : <ListIcon />}
              label={listObj ? listObj.name : undefined}
              title="List"
              active={!!listObj}
              onClick={list.toggle}
              onClear={() => set({ listId: null })}
              anchorRef={list.ref}
            />
          </div>
        </div>
      </div>

      <div className="new-task-foot">
        <span className={`help${tried && error ? ' bad' : ''}`} role={tried && error ? 'alert' : undefined}>
          {tried && error ? error : parsed.hints.length && text ? `Got it: ${parsed.hints.join(' · ')}` : 'Try “tomorrow 4pm !3 #exam”'}
        </span>
        <span className="spacer" />
        <button type="button" className="btn ghost sm" onClick={onClose}>Cancel</button>
        <button className="btn sm" disabled={!!error} title={error || 'Add task (Enter)'}>Add</button>
      </div>

      {date.open && <Popover anchor={date.anchor} onClose={date.close} label="Date"><DatePicker value={due} onPick={(d) => { set(d ? { due: d } : { due: null, time: null, repeat: null }); date.close() }} /></Popover>}
      {time.open && <Popover anchor={time.anchor} onClose={time.close} label="Time"><TimePicker value={time_} onPick={(t) => { set(t && !due ? { time: t, due: todayKey() } : { time: t }); time.close() }} /></Popover>}
      {repeat.open && (
        <Popover anchor={repeat.anchor} onClose={repeat.close} label="Repeat" width={300}>
          <RepeatPicker value={rep} due={due} weekStartsMonday={weekStartsMonday} onPick={(r) => { set(r && !due ? { repeat: r, due: todayKey() } : { repeat: r }); repeat.close() }} />
        </Popover>
      )}
      {linkPop.open && (
        <Popover anchor={linkPop.anchor} onClose={linkPop.close} label="Add a link" width={300}>
          <AddLinkForm onAdd={(l) => { if (!allLinks.some((x) => x.url === l.url)) setLinks([...links, l]); linkPop.close() }} />
        </Popover>
      )}
      {waPop.open && (
        <Popover anchor={waPop.anchor} onClose={waPop.close} label="WhatsApp me" width={300}>
          <WaPicker task={{ due, time: time_, wa }} onPick={(v) => { set({ wa: v }); waPop.close() }} />
        </Popover>
      )}
      {stat.open && (
        <Popover anchor={stat.anchor} onClose={stat.close} label="Status">
          <div className="menu" role="menu">
            {STATUSES.map((st) => (
              <MenuItem key={st} icon={<span className={`status-dot st-${st}`} />} label={STATUS_LABEL[st]} selected={status === st} onClick={() => { set({ status: st }); stat.close() }} />
            ))}
          </div>
        </Popover>
      )}
      {bell.open && (
        <Popover anchor={bell.anchor} onClose={bell.close} label="Reminder">
          <RemindPicker value={remind} onPick={(v) => { set({ remind: v }); bell.close() }} />
        </Popover>
      )}
      {prio.open && (
        <Popover anchor={prio.anchor} onClose={prio.close} label="Priority">
          <div className="menu" role="menu">
            {([0, 1, 2, 3] as Priority[]).map((p) => (
              <MenuItem key={p} icon={p ? <span className={`prio p${p}`}>{'!'.repeat(p)}</span> : undefined} label={PRIORITY_LABEL[p]} selected={priority === p} onClick={() => { set({ priority: p }); prio.close() }} />
            ))}
          </div>
        </Popover>
      )}
      {list.open && (
        <Popover anchor={list.anchor} onClose={list.close} label="List">
          <div className="menu" role="menu">
            <MenuItem label="No list" selected={!listId} onClick={() => { set({ listId: null }); list.close() }} />
            {lists.map((l) => (
              <MenuItem key={l.id} icon={<i className={`swatch ${colorClass(l.color)}`} />} label={`${l.emoji} ${l.name}`} selected={listId === l.id} onClick={() => { set({ listId: l.id }); list.close() }} />
            ))}
            <div className="menu-sep" />
            <MenuItem label="+ New list…" onClick={() => { list.close(); onNewList() }} />
          </div>
        </Popover>
      )}
    </form>
  )
}
