import { colorClass } from '../listColor'
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { addDays, formatDue, todayKey, toKey } from '../dates'
import { parseQuickAdd } from '../quickadd'
import { defaultRemind } from '../prefs'
import { STATUS_LABEL, statusOf, type Status } from '../status'
import { streakDays } from '../stats'
import type { List, Priority, StickyColor, Task, TaskInput, Widget, WidgetType } from '../types'
import { Fire } from './Fire'
import { PRIORITY_LABEL, StatusButton } from './TaskItem'

/** Everything a board block needs from the app. */
export interface WidgetEnv {
  tasks: Task[]
  lists: List[]
  onOpen: (t: Task) => void
  onToggle: (t: Task, e?: MouseEvent) => void
  onStatus: (t: Task, s: Status) => void
  onUpdate: (id: string, patch: Partial<Task>) => void
  onAdd: (input: TaskInput & { title: string }) => void
  onReorder: (ids: string[]) => void
  onShowTodo: () => void
}

export const WIDGET_INFO: Record<WidgetType, { icon: string; name: string; help: string }> = {
  priority: { icon: '🚩', name: 'Priority board', help: 'Drag tasks between columns to change priority.' },
  todo: { icon: '✅', name: 'To-do list', help: 'All your open tasks.' },
  status: { icon: '🚦', name: 'Status board', help: 'Drag tasks between columns to change status.' },
  today: { icon: '☀️', name: 'Today', help: 'Overdue and due today.' },
  upcoming: { icon: '🗓️', name: 'Next 7 days', help: 'The week ahead.' },
  doing: { icon: '⏳', name: 'In progress', help: 'Tasks you’ve started.' },
  overdue: { icon: '⚠️', name: 'Overdue', help: 'Past due and not done.' },
  list: { icon: '📋', name: 'One list', help: 'Open tasks from one list.' },
  stats: { icon: '📊', name: 'Quick stats', help: 'Open, done today, streak.' },
  notes: { icon: '📝', name: 'Sticky note', help: 'Free text.' },
}

const sensorsConfig = () => [
  useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
]

// ------------------------------------------------------------------ a task
function MiniTask({ task, env, list, handle }: { task: Task; env: WidgetEnv; list?: List; handle?: ReactNode }) {
  const st = statusOf(task)
  const today = todayKey()
  const late = !task.done && task.due && task.due < today
  return (
    <div className={`mini-task st-${st}${task.done ? ' done' : ''}`}>
      {handle}
      <StatusButton status={st} title={task.title} onCycle={(e) => { e.stopPropagation(); env.onToggle(task, e) }} />
      <button type="button" className="mini-body" onClick={() => env.onOpen(task)} title="Open details">
        <span className="mini-title">{task.title}</span>
        <span className="mini-meta">
          {task.priority > 0 && <span className={`mini-prio p${task.priority}`}>{'!'.repeat(task.priority)}</span>}
          {task.due && <span className={late ? 'late' : ''}>{formatDue(task)}</span>}
          {list && <span className="mini-list"><i className={`swatch ${colorClass(list.color)}`} aria-hidden="true" />{list.emoji} {list.name}</span>}
        </span>
      </button>
    </div>
  )
}

function SortableMini({ task, env, list }: { task: Task; env: WidgetEnv; list?: List }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={isDragging ? 'dragging' : ''} data-task-id={task.id}>
      <MiniTask
        task={task}
        env={env}
        list={list}
        handle={<button type="button" className="grip" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Drag ${task.title}`}>⠿</button>}
      />
    </li>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="widget-empty">{children}</p>
}

// ------------------------------------------------------------ plain lists
function MiniList({ tasks, env, empty, showList = true }: { tasks: Task[]; env: WidgetEnv; empty: string; showList?: boolean }) {
  if (!tasks.length) return <Empty>{empty}</Empty>
  const byId = new Map(env.lists.map((l) => [l.id, l]))
  return (
    <ul className="mini-list-ul">
      {tasks.map((t) => <li key={t.id}><MiniTask task={t} env={env} list={showList && t.listId ? byId.get(t.listId) : undefined} /></li>)}
    </ul>
  )
}

const open = (tasks: Task[]) => tasks.filter((t) => !t.done)
const byDue = (a: Task, b: Task) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || b.priority - a.priority

// ---------------------------------------------------------------- to-do
function TodoWidget({ env }: { env: WidgetEnv }) {
  const tasks = open(env.tasks).sort((a, b) => a.order - b.order)
  const [text, setText] = useState('')
  const sensors = useSensors(...sensorsConfig())
  const byId = new Map(env.lists.map((l) => [l.id, l]))
  const add = (e: FormEvent) => {
    e.preventDefault()
    const p = parseQuickAdd(text, env.lists)
    if (!p.title.trim()) return
    // same rules as the main add box: a time without a date means today, and a time gets the default reminder
    const due = p.due ?? (p.time ? todayKey() : null)
    env.onAdd({ title: p.title.trim(), due, time: p.time ?? null, remind: p.time ? defaultRemind() : null, priority: p.priority ?? 0, tags: p.tags || [], listId: p.listId ?? null, repeat: p.repeat ?? null, links: p.links || [] })
    setText('')
  }
  const end = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = tasks.map((t) => t.id)
    env.onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
  }
  return (
    <>
      <form className="widget-add" onSubmit={add}>
        <input className="input sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="+ Add a task" aria-label="Add a task" />
      </form>
      {tasks.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={end}>
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <ul className="mini-list-ul">{tasks.map((t) => <SortableMini key={t.id} task={t} env={env} list={t.listId ? byId.get(t.listId) : undefined} />)}</ul>
          </SortableContext>
        </DndContext>
      ) : <Empty>Nothing to do.</Empty>}
    </>
  )
}

// ------------------------------------------------------ columns (kanban)
function Column({ id, title, tone, tasks, env }: { id: string; title: string; tone: string; tasks: Task[]; env: WidgetEnv }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}` })
  const byId = new Map(env.lists.map((l) => [l.id, l]))
  return (
    <div ref={setNodeRef} className={`kan-col ${tone}${isOver ? ' over' : ''}`} data-col={id}>
      <h4><span>{title}</span><span className="count">{tasks.length}</span></h4>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul className="mini-list-ul">
          {tasks.map((t) => <SortableMini key={t.id} task={t} env={env} list={t.listId ? byId.get(t.listId) : undefined} />)}
          {!tasks.length && <li className="kan-drop">Drop here</li>}
        </ul>
      </SortableContext>
    </div>
  )
}

/** Columns of tasks; dropping on another column calls `move`, within a column it reorders. */
function Kanban<K extends string | number>({ cols, keyOf, move, env }: {
  cols: { key: K; title: string; tone: string; tasks: Task[] }[]
  keyOf: (t: Task) => K
  move: (t: Task, to: K) => void
  env: WidgetEnv
}) {
  const sensors = useSensors(...sensorsConfig())
  const end = ({ active, over }: DragEndEvent) => {
    if (!over) return
    const task = env.tasks.find((t) => t.id === active.id)
    if (!task) return
    const overId = String(over.id)
    const target = overId.startsWith('col:')
      ? cols.find((c) => `col:${c.key}` === overId)
      : cols.find((c) => c.tasks.some((t) => t.id === overId))
    if (!target) return
    if (target.key !== keyOf(task)) return move(task, target.key)
    if (overId.startsWith('col:') || overId === task.id) return
    const ids = target.tasks.map((t) => t.id)
    env.onReorder(arrayMove(ids, ids.indexOf(task.id), ids.indexOf(overId)))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={end}>
      <div className="kanban" style={{ ['--cols' as string]: cols.length }}>
        {cols.map((c) => <Column key={String(c.key)} id={String(c.key)} title={c.title} tone={c.tone} tasks={c.tasks} env={env} />)}
      </div>
    </DndContext>
  )
}

function PriorityWidget({ env }: { env: WidgetEnv }) {
  const tasks = open(env.tasks).sort((a, b) => a.order - b.order)
  const cols = ([3, 2, 1, 0] as Priority[]).map((p) => ({ key: p, title: PRIORITY_LABEL[p], tone: `p${p}`, tasks: tasks.filter((t) => t.priority === p) }))
  return <Kanban cols={cols} keyOf={(t) => t.priority} move={(t, p) => env.onUpdate(t.id, { priority: p })} env={env} />
}

function StatusWidget({ env }: { env: WidgetEnv }) {
  const weekAgo = Date.now() - 7 * 864e5
  const sorted = [...env.tasks].sort((a, b) => a.order - b.order)
  const cols = (['todo', 'doing', 'done'] as Status[]).map((s) => ({
    key: s, title: STATUS_LABEL[s], tone: `st-${s}`,
    tasks: sorted.filter((t) => statusOf(t) === s && (s !== 'done' || (t.doneAt || 0) > weekAgo)).slice(0, s === 'done' ? 15 : 200),
  }))
  return <Kanban cols={cols} keyOf={statusOf} move={env.onStatus} env={env} />
}

function StatsWidget({ env }: { env: WidgetEnv }) {
  const today = todayKey()
  const left = open(env.tasks).length
  const doneToday = env.tasks.filter((t) => t.done && t.doneAt && toKey(new Date(t.doneAt)) === today).length
  const days = streakDays(env.tasks)
  return (
    <div className="quick-stats">
      <button type="button" className="qs link" onClick={env.onShowTodo}><b>{left}</b><span>Still to do →</span></button>
      <div className="qs"><b>{doneToday}</b><span>Done today</span></div>
      <div className="qs"><b><Fire days={days} /></b><span>{days}-day streak</span></div>
    </div>
  )
}

export const STICKY_COLORS: StickyColor[] = ['yellow', 'pink', 'green', 'blue', 'purple']

function NotesWidget({ widget, onConfig }: { widget: Widget; onConfig: (c: Widget['config']) => void }) {
  const [text, setText] = useState(widget.config.text || '')
  useEffect(() => setText(widget.config.text || ''), [widget.config.text])
  const color = widget.config.color || 'yellow'
  return (
    <div className={`sticky-wrap sticky-${color}`}>
      <textarea
        className="sticky"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== (widget.config.text || '')) onConfig({ ...widget.config, text }) }}
        placeholder="Write anything…"
        maxLength={2000}
        aria-label={`${widget.title || 'Sticky note'} text`}
      />
      <div className="sticky-colors" role="radiogroup" aria-label="Note colour">
        {STICKY_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} className={`sticky-${c}${c === color ? ' on' : ''}`}
            onClick={() => onConfig({ ...widget.config, text, color: c })} />
        ))}
      </div>
    </div>
  )
}

/** The inside of one block. */
export function WidgetBody({ widget, env, onConfig }: { widget: Widget; env: WidgetEnv; onConfig: (c: Widget['config']) => void }) {
  const today = todayKey()
  const active = open(env.tasks)
  switch (widget.type) {
    case 'priority': return <PriorityWidget env={env} />
    case 'status': return <StatusWidget env={env} />
    case 'todo': return <TodoWidget env={env} />
    case 'stats': return <StatsWidget env={env} />
    case 'notes': return <NotesWidget widget={widget} onConfig={onConfig} />
    case 'today': return <MiniList env={env} tasks={active.filter((t) => t.due && t.due <= today).sort(byDue)} empty="Nothing due today." />
    case 'upcoming': {
      const end = addDays(today, 7)
      return <MiniList env={env} tasks={active.filter((t) => t.due && t.due > today && t.due <= end).sort(byDue)} empty="Nothing in the next 7 days." />
    }
    case 'doing': return <MiniList env={env} tasks={active.filter((t) => statusOf(t) === 'doing').sort(byDue)} empty="Nothing in progress." />
    case 'overdue': return <MiniList env={env} tasks={active.filter((t) => t.due && t.due < today).sort(byDue)} empty="Nothing overdue." />
    case 'list': {
      const l = env.lists.find((x) => x.id === widget.config.listId)
      if (!l) return <Empty>Pick a list with “Edit board”.</Empty>
      return <MiniList env={env} showList={false} tasks={active.filter((t) => t.listId === l.id).sort((a, b) => a.order - b.order)} empty={`Nothing open in ${l.name}.`} />
    }
  }
}
