import { colorClass } from '../listColor'
import { memo, type CSSProperties, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { formatDue, isOverdue } from '../dates'
import { describeRepeat } from '../repeat'
import type { List, Task } from '../types'
import { STATUS_LABEL, nextStatus, statusOf, type Status } from '../status'
import { ExtLink } from './Links'
import { WaIcon, describeWa, waSent } from './WaPicker'
import { Icon } from './Icon'

export const PRIORITY_LABEL = ['None', 'Low', 'Medium', 'High'] as const

export function Check({ done, onToggle, label }: { done: boolean; onToggle: (e: MouseEvent) => void; label: string }) {
  return (
    <button type="button" className={`check${done ? ' on' : ''}`} role="checkbox" aria-checked={done} aria-label={label} onClick={onToggle}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5 8.5 13.5 14.5 7" /></svg>
    </button>
  )
}

/**
 * The round button on a task: tap to go Not started → In progress → Completed.
 * Red ring, yellow half-filled, green with a tick (and always a text label
 * nearby, so colour is never the only clue).
 */
export function StatusButton({ status, onCycle, title }: { status: Status; onCycle: (e: MouseEvent) => void; title: string }) {
  return (
    <button
      type="button"
      className={`status-btn st-${status}`}
      onClick={onCycle}
      aria-label={`${title}: ${STATUS_LABEL[status]}. Tap for ${STATUS_LABEL[nextStatus(status)]}`}
      title={`${STATUS_LABEL[status]} · tap for ${STATUS_LABEL[nextStatus(status)]}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="ring" cx="12" cy="12" r="9.5" />
        <path className="half" d="M12 2.5a9.5 9.5 0 0 0 0 19z" />
        <path className="tick" d="M7.5 12.5 10.5 15.5 16.5 9" />
      </svg>
    </button>
  )
}

/** Thin bar under a task: its steps done (or where its status is), in the status colour. */
export function TaskProgress({ task }: { task: Task }) {
  const status = statusOf(task)
  const steps = task.subtasks.length
  const done = task.subtasks.filter((s) => s.done).length
  const pct = status === 'done' ? 100 : steps ? Math.round((done / steps) * 100) : status === 'doing' ? 50 : 0
  const label = steps ? `${STATUS_LABEL[status]}, ${done} of ${steps} steps done` : STATUS_LABEL[status]
  return (
    <span className={`task-progress st-${status}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} title={label}>
      <span style={{ width: `${Math.max(pct, status === 'todo' ? 6 : 0)}%` }} />
    </span>
  )
}

export function ListChip({ list }: { list: List }) {
  return (
    <span className="list-chip">
      <i className={`swatch ${colorClass(list.color)}`} aria-hidden="true" />
      {list.emoji} {list.name}
    </span>
  )
}

export interface TaskHandlers {
  onOpen: (t: Task) => void // expand in place
  onDetails: (t: Task) => void
  onDelete: (t: Task) => void
  onToggle: (t: Task, e: MouseEvent) => void
}

interface Props extends TaskHandlers {
  task: Task
  list?: List
  showList: boolean
  selected: boolean
  expanded: boolean
  inline?: ReactNode // the inline editor, shown in place of the title while expanded
  dragHandle?: HTMLAttributes<HTMLButtonElement>
  style?: CSSProperties
  innerRef?: (el: HTMLElement | null) => void
  dragging?: boolean
}

/** Added in the last moment (not just loaded): gets a little entrance. */
const shallowSame = (a: object | undefined, b: object | undefined) => {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => (a as any)[k] === (b as any)[k])
}
/** Drag-and-drop hands every row a fresh style / handle object each time: compare what's inside them. */
const sameProps = (a: Props, b: Props) => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Props>) {
    if (k === 'style' || k === 'dragHandle') { if (!shallowSame(a[k], b[k])) return false }
    else if (a[k] !== b[k]) return false
  }
  return true
}

const isFresh = (t: Task) => Date.now() - t.createdAt < 1500

/**
 * One task row. Memoised: the handlers are stable (see useEvent) and tasks that
 * didn't change keep their object, so a change elsewhere doesn't redraw this row.
 */
export const TaskItem = memo(function TaskItem({ task, list, showList, selected, expanded, inline, onOpen, onDetails, onDelete, onToggle, dragHandle, style, innerRef, dragging }: Props) {
  const overdue = isOverdue(task)
  const saving = task.id.startsWith('tmp-')
  const subDone = task.subtasks.filter((s) => s.done).length
  const status = statusOf(task)
  return (
    <li
      ref={innerRef}
      style={style}
      className={`task p${task.priority} st-${status}${task.done ? ' done' : ''}${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''}${saving ? ' saving' : ''}${isFresh(task) ? ' fresh' : ''}`}
    >
      {dragHandle && (
        <button type="button" className="grip" aria-label={`Drag to reorder ${task.title}`} {...dragHandle}>
          <svg viewBox="0 0 12 20" aria-hidden="true"><circle cx="3" cy="4" r="1.6" /><circle cx="9" cy="4" r="1.6" /><circle cx="3" cy="10" r="1.6" /><circle cx="9" cy="10" r="1.6" /><circle cx="3" cy="16" r="1.6" /><circle cx="9" cy="16" r="1.6" /></svg>
        </button>
      )}
      <StatusButton status={status} onCycle={(e) => onToggle(task, e)} title={task.title} />
      {expanded && inline ? inline : (
      <>
      <div className="task-main">
      <button type="button" className="task-body" onClick={() => onOpen(task)} disabled={saving} aria-expanded={false}>
        <span className="task-title">{task.title}</span>
        {task.notes && <span className="task-note">{task.notes.split('\n').find((l) => l.trim()) || ''}</span>}
        <span className="task-meta">
          {status !== 'done' && <span className={`status-pill st-${status}`}>{STATUS_LABEL[status]}</span>}
          {task.from && <span className="meta from" title={`Given to you by ${task.from.name}`}><Icon name="pin" />From {task.from.name}</span>}
          {task.chat && <span className="meta chat" title={`From your chat with ${task.chat.name}`}><Icon name="chat" />{task.chat.name}</span>}
          {task.due && (
            <span className={`meta due${overdue ? ' overdue' : ''}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2.5" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></svg>
              {formatDue(task)}
              {task.remind !== null && <Icon name="bell" label="Reminder set" />}
            </span>
          )}
          {task.wa && !task.done && (
            <span className={`meta wa${waSent(task) ? ' sent' : ''}`} title="WhatsApp Buddy will message you"><WaIcon />{describeWa(task)}</span>
          )}
          {task.repeat && (
            <span className="meta">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 7V6a2 2 0 0 1 2-2h7l-2-2M13 9v1a2 2 0 0 1-2 2H4l2 2" /></svg>
              {describeRepeat(task.repeat)}
            </span>
          )}
          {task.priority > 0 && (
            <span className={`meta prio p${task.priority}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5h8l-1.8 3 1.8 3h-8" /></svg>
              {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          {task.subtasks.length > 0 && (
            <span className="meta">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6" /></svg>
              {subDone}/{task.subtasks.length}
            </span>
          )}
          {task.tags.map((t) => <span key={t} className="meta tag">#{t}</span>)}
          {showList && list && <ListChip list={list} />}
        </span>
        <TaskProgress task={task} />
      </button>
      {task.links?.length > 0 && (
        <div className="task-links">{task.links.map((l) => <ExtLink key={l.url} link={l} />)}</div>
      )}
      </div>
      {!saving && (
        <span className="row-actions">
          <button type="button" className="icon-btn sm" onClick={() => onDetails(task)} aria-label={`Details for ${task.title}`} title="Details">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6.2v.01" /></svg>
          </button>
          <button type="button" className="icon-btn sm del" onClick={() => onDelete(task)} aria-label={`Delete ${task.title}`} title="Delete">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5" /></svg>
          </button>
        </span>
      )}
      </>
      )}
    </li>
  )
}, sameProps)
