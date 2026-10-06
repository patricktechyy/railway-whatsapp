import { colorClass } from '../listColor'
import { defaultRemind } from '../prefs'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { describeRemind, formatDay, formatTime, todayKey } from '../dates'
import { describeRepeat } from '../repeat'
import type { List, Priority, Subtask, Task, TaskInput } from '../types'
import { Check, PRIORITY_LABEL, StatusButton } from './TaskItem'
import { STATUSES, STATUS_LABEL, statusOf, type Status } from '../status'
import { MenuItem, Popover, usePopover } from './Popover'
import { RemindPicker } from './RemindPicker'
import { ClockIcon, TimePicker } from './TimePicker'
import { CalendarIcon, DatePicker } from './DatePicker'
import { RepeatIcon, RepeatPicker } from './RepeatPicker'
import { Switch } from './Switch'
import { enablePush, permission, pushSupport } from '../push'
import { openWhatsAppChat } from '../api'
import { WhatsUpLogo } from './Login'
import { AddLinkForm, ExtLink, LinkIcon } from './Links'
import { WaIcon, WaPicker, describeWa } from './WaPicker'

interface Props {
  task: Task
  lists: List[]
  weekStartsMonday: boolean
  onChange: (patch: TaskInput) => void
  onToggle: () => void
  onStatus: (s: Status) => void
  onDelete: () => void
  onClose: () => void
  onNewList: () => void
  onShare?: () => void // "Send on WhatsApp" (only when the WhatsApp link is on)
  waOn?: boolean // WhatsApp Buddy can message you ("💬 WhatsApp me")
}

const newId = () => Math.random().toString(36).slice(2, 10)

const Chevron = () => <svg className="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5 10 2.5l3 3M7 14.5l3 3 3-3" /></svg>
const BellIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13zM8.5 17.5h3" /></svg>
const ListIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9" /><circle cx="4" cy="5.5" r="1" /><circle cx="4" cy="10" r="1" /><circle cx="4" cy="14.5" r="1" /></svg>
const HashIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3 6.5 17M13.5 3 12 17M3.5 7.5h14M2.5 12.5h14" /></svg>
const BangIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v9M10 16.5v.01" /></svg>
const StepsIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h10M3 8h14M3 11.5h10M3 15h7" /></svg>

/** A row in a grouped card: icon, label (+ value underneath), and something on the right. */
function Row({ icon, label, value, right, onClick, disabled, anchorRef }: {
  icon: ReactNode
  label: string
  value?: ReactNode
  right?: ReactNode
  onClick?: () => void
  disabled?: boolean
  anchorRef?: (el: HTMLButtonElement | null) => void
}) {
  const body = (
    <>
      <span className="row-icon">{icon}</span>
      <span className="row-text">
        <span className="row-label">{label}</span>
        {value && <span className="row-value">{value}</span>}
      </span>
    </>
  )
  return (
    <div className={`row-item${disabled ? ' disabled' : ''}`}>
      {onClick ? <button type="button" className="row-main" onClick={onClick} disabled={disabled} ref={anchorRef}>{body}</button> : <div className="row-main">{body}</div>}
      {right}
    </div>
  )
}

/** A row whose value is on the right with ⇅, like "Repeat   Never ⇅". */
function SelectRow({ icon, label, value, onClick, anchorRef, disabled }: {
  icon: ReactNode; label: string; value: ReactNode; onClick: () => void; anchorRef: (el: HTMLButtonElement | null) => void; disabled?: boolean
}) {
  return (
    <div className={`row-item${disabled ? ' disabled' : ''}`}>
      <button type="button" className="row-main select" onClick={onClick} ref={anchorRef} disabled={disabled}>
        <span className="row-icon">{icon}</span>
        <span className="row-label">{label}</span>
        <span className="row-right">{value}<Chevron /></span>
      </button>
    </div>
  )
}

/** The details panel, laid out like Reminders' ⓘ panel. Every field saves as you go. */
export function TaskEditor({ task, lists, weekStartsMonday, onChange, onToggle, onStatus, onDelete, onClose, onNewList, onShare, waOn }: Props) {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [tagText, setTagText] = useState('')
  const [sub, setSub] = useState('')
  const date = usePopover()
  const time = usePopover()
  const repeat = usePopover()
  const remind = usePopover()
  const wa = usePopover()
  const list = usePopover()
  const prio = usePopover()
  const stat = usePopover()

  // another device (or the list) changed this task: take the new values
  useEffect(() => { setTitle(task.title) }, [task.id, task.title])
  useEffect(() => { setNotes(task.notes) }, [task.id, task.notes])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[data-popover]')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveTitle = () => {
    const t = title.trim()
    if (!t) return setTitle(task.title)
    if (t !== task.title) onChange({ title: t })
  }
  const saveNotes = () => { if (notes !== task.notes) onChange({ notes }) }

  const setSubtasks = (subtasks: Subtask[]) => onChange({ subtasks })
  const addSub = (e: FormEvent) => {
    e.preventDefault()
    const t = sub.trim()
    if (!t) return
    setSubtasks([...task.subtasks, { id: newId(), title: t, done: false }])
    setSub('')
  }
  const addTag = (e: FormEvent) => {
    e.preventDefault()
    const t = tagText.trim().replace(/^#/, '').toLowerCase()
    if (t && !task.tags.includes(t)) onChange({ tags: [...task.tags, t] })
    setTagText('')
  }

  const listObj = lists.find((l) => l.id === task.listId)
  const rep = task.repeat ?? null
  const created = new Date(task.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const remindLabel = task.remind === null ? 'None' : describeRemind(task.remind)

  return (
    <aside className="editor" aria-label="Task details">
      <header className="editor-head">
        <StatusButton status={statusOf(task)} onCycle={onToggle} title="Status" />
        <textarea
          className="editor-title"
          value={title}
          rows={1}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
          onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }}
          aria-label="Title"
        />
        <button className="icon-btn" onClick={onClose} aria-label="Close details">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
        </button>
      </header>
      {task.from && <p className="from-note">📌 From <b>{task.from.name}</b></p>}
      {task.chat && (
        <p className="from-note chat-note">
          <WhatsUpLogo size={16} /> From your chat with <b>{task.chat.name}</b>
          <button type="button" className="linkish" onClick={() => openWhatsAppChat(task.chat!.jid)}>Open chat</button>
        </p>
      )}

      <div className="editor-body">
        <div className="group-card">
          <textarea className="notes-input" rows={2} value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} placeholder="Notes" aria-label="Notes" />
        </div>

        <div className="group-card">
          <SelectRow
            icon={<span className={`status-dot st-${statusOf(task)}`} />}
            label="Status"
            value={STATUS_LABEL[statusOf(task)]}
            onClick={stat.toggle}
            anchorRef={stat.ref}
          />
        </div>
        {stat.open && (
          <Popover anchor={stat.anchor} onClose={stat.close} label="Status">
            <div className="menu" role="menu">
              {STATUSES.map((st) => (
                <MenuItem key={st} icon={<span className={`status-dot st-${st}`} />} label={STATUS_LABEL[st]} selected={statusOf(task) === st} onClick={() => { onStatus(st); stat.close() }} />
              ))}
            </div>
          </Popover>
        )}

        <h4 className="card-title">Date &amp; Time</h4>
        <div className="group-card">
          <Row
            icon={<CalendarIcon />}
            label="Date"
            value={task.due ? formatDay(task.due) : undefined}
            onClick={date.toggle}
            anchorRef={date.ref}
            right={<Switch on={!!task.due} label="Date" onChange={(on) => onChange({ due: on ? todayKey() : null })} />}
          />
          <Row
            icon={<ClockIcon />}
            label="Time"
            value={task.time ? formatTime(task.time, true) : undefined}
            onClick={task.due ? time.toggle : undefined}
            anchorRef={time.ref}
            disabled={!task.due}
            right={<Switch on={!!task.time} label="Time" disabled={!task.due} onChange={(on) => onChange(on ? { time: '09:00', ...(task.remind === null ? { remind: defaultRemind() } : {}) } : { time: null })} />}
          />
        </div>
        {date.open && <Popover anchor={date.anchor} onClose={date.close} label="Date"><DatePicker value={task.due} onPick={(d) => { onChange({ due: d }); date.close() }} /></Popover>}
        {time.open && <Popover anchor={time.anchor} onClose={time.close} label="Time"><TimePicker value={task.time} onPick={(t) => { onChange(t && task.remind === null && !task.time ? { time: t, remind: defaultRemind() } : { time: t }); time.close() }} /></Popover>}

        <div className="group-card">
          <SelectRow icon={<RepeatIcon />} label="Repeat" value={describeRepeat(rep)} onClick={repeat.toggle} anchorRef={repeat.ref} />
          <SelectRow icon={<BellIcon />} label="Early reminder" value={task.due ? remindLabel.replace('No reminder', 'None') : 'None'} onClick={remind.toggle} anchorRef={remind.ref} disabled={!task.due} />
          {waOn && <SelectRow icon={<WaIcon />} label="WhatsApp me" value={describeWa(task) || 'Off'} onClick={wa.toggle} anchorRef={wa.ref} />}
        </div>
        {!task.due && <p className="help card-help">Set a date to add a reminder.</p>}
        {wa.open && (
          <Popover anchor={wa.anchor} onClose={wa.close} label="WhatsApp me" width={300}>
            <WaPicker task={task} onPick={(v) => { onChange({ wa: v }); wa.close() }} />
          </Popover>
        )}
        {repeat.open && (
          <Popover anchor={repeat.anchor} onClose={repeat.close} label="Repeat" width={300}>
            <RepeatPicker value={rep} due={task.due} weekStartsMonday={weekStartsMonday} onPick={(r) => { onChange(task.due || !r ? { repeat: r } : { due: todayKey(), repeat: r }); repeat.close() }} />
          </Popover>
        )}
        {remind.open && (
          <Popover anchor={remind.anchor} onClose={remind.close} label="Early reminder">
            <RemindPicker
              value={task.remind}
              onPick={(v) => {
                onChange({ remind: v })
                remind.close()
                // first reminder on this device: offer notifications (and subscribe, so they work with the site closed)
                if (v !== null && pushSupport() === 'ok' && permission() === 'default') enablePush().catch(() => {})
              }}
            />
          </Popover>
        )}

        <h4 className="card-title">Organisation</h4>
        <div className="group-card">
          <SelectRow
            icon={<ListIcon />}
            label="List"
            value={listObj ? <span className="list-chip"><i className={`swatch ${colorClass(listObj.color)}`} aria-hidden="true" />{listObj.name}</span> : 'No list'}
            onClick={list.toggle}
            anchorRef={list.ref}
          />
          <div className="row-item tags-row">
            <div className="row-main">
              <span className="row-icon"><HashIcon /></span>
              <span className="row-label">Tags</span>
            </div>
            <div className="tag-edit">
              {task.tags.map((t) => (
                <span key={t} className="badge">
                  #{t}
                  <button type="button" className="x" aria-label={`Remove tag ${t}`} onClick={() => onChange({ tags: task.tags.filter((x) => x !== t) })}>×</button>
                </span>
              ))}
              <form onSubmit={addTag} className="inline-form">
                <input className="bare-input" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="Add tag" maxLength={24} aria-label="Add tag" />
              </form>
            </div>
          </div>
          <SelectRow icon={<BangIcon />} label="Priority" value={PRIORITY_LABEL[task.priority]} onClick={prio.toggle} anchorRef={prio.ref} />
        </div>
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
        {prio.open && (
          <Popover anchor={prio.anchor} onClose={prio.close} label="Priority">
            <div className="menu" role="menu">
              {([0, 1, 2, 3] as Priority[]).map((p) => (
                <MenuItem key={p} icon={p ? <span className={`prio p${p}`}>{'!'.repeat(p)}</span> : undefined} label={PRIORITY_LABEL[p]} selected={task.priority === p} onClick={() => { onChange({ priority: p }); prio.close() }} />
              ))}
            </div>
          </Popover>
        )}

        <h4 className="card-title">Links</h4>
        <div className="group-card links-card">
          {(task.links || []).map((l) => (
            <div key={l.url} className="row-item link-row">
              <ExtLink link={l} className="link-open" />
              <button type="button" className="icon-btn sm" aria-label={`Remove link ${l.title || l.url}`} onClick={() => onChange({ links: task.links.filter((x) => x.url !== l.url) })}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
              </button>
            </div>
          ))}
          <div className="row-item add-link-row">
            <span className="row-icon"><LinkIcon /></span>
            <AddLinkForm autoFocus={false} onAdd={(l) => { if (!(task.links || []).some((x) => x.url === l.url)) onChange({ links: [...(task.links || []), l] }) }} />
          </div>
        </div>

        <h4 className="card-title">
          Steps {task.subtasks.length > 0 && <span className="muted">{task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}</span>}
        </h4>
        <div className="group-card">
          {task.subtasks.map((s) => (
            <div key={s.id} className={`row-item step${s.done ? ' done' : ''}`}>
              <Check done={s.done} label={s.done ? `Mark step "${s.title}" as not done` : `Mark step "${s.title}" as done`} onToggle={() => setSubtasks(task.subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)))} />
              <span className="step-title">{s.title}</span>
              <button type="button" className="icon-btn sm" aria-label={`Delete step ${s.title}`} onClick={() => setSubtasks(task.subtasks.filter((x) => x.id !== s.id))}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
              </button>
            </div>
          ))}
          <form onSubmit={addSub} className="row-item">
            <span className="row-icon"><StepsIcon /></span>
            <input className="bare-input" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Add a step" maxLength={200} aria-label="Add a step" />
          </form>
        </div>
      </div>

      {onShare && (
        <div className="editor-share">
          <button className="btn ghost full wa-btn" onClick={onShare}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 15.8 5.4 12.6A6.5 6.5 0 1 1 7.8 15z" /><path d="M8 7.5c.2 1.8 2.2 3.8 4 4l.8-1-1.3-.7-.6.6c-.8-.3-1.5-1-1.8-1.8l.6-.6-.7-1.3z" /></svg>
            Send on WhatsApp
          </button>
        </div>
      )}
      <footer className="editor-foot">
        <span className="help">
          Created {created}
          {task.done && task.doneAt ? ` · Done ${new Date(task.doneAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''}
        </span>
        <button className="btn danger" onClick={onDelete}>Delete</button>
      </footer>
    </aside>
  )
}
