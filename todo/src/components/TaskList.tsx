import { memo, useMemo, type ReactNode } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { List, Task } from '../types'
import { rowKey } from '../useData'
import { Collapsible } from './Collapsible'
import { TaskItem, type TaskHandlers } from './TaskItem'

export interface Group {
  key: string
  title?: ReactNode
  tone?: 'danger'
  tasks: Task[]
  /** A button that acts on this group (e.g. Clear completed), shown at the right of its title. */
  action?: ReactNode
  /** Rolled up (only the title shows); `onFold` makes the title a toggle. */
  folded?: boolean
  onFold?: () => void
}

interface Props {
  groups: Group[]
  lists: List[]
  showList: boolean
  selectedId: string | null
  expandedId: string | null
  renderInline: (t: Task) => ReactNode
  sortable: boolean
  handlers: TaskHandlers
  onReorder: (ids: string[]) => void
  empty: ReactNode
}

type RowProps = Omit<Parameters<typeof TaskItem>[0], 'dragHandle' | 'style' | 'innerRef' | 'dragging'>

const SortableTask = memo(function SortableTask(props: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.task.id })
  return (
    <TaskItem
      {...props}
      innerRef={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragging={isDragging}
      dragHandle={{ ...attributes, ...listeners, ref: setActivatorNodeRef } as any}
    />
  )
})

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chev${open ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
)

function GroupBlock({ g, sortable, byId, props }: { g: Group; sortable: boolean; byId: Map<string, List>; props: Props }) {
  const { showList, selectedId, expandedId, renderInline, handlers, onReorder } = props
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // the same ids keep the same array, so the drag context (and every row) doesn't refresh needlessly
  const idKey = g.tasks.map((t) => t.id).join(',')
  const ids = useMemo(() => (idKey ? idKey.split(',') : []), [idKey])
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    onReorder(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))))
  }
  const row = (t: Task, Row: typeof TaskItem | typeof SortableTask) => (
    <Row
      key={rowKey(t.id)}
      task={t}
      list={t.listId ? byId.get(t.listId) : undefined}
      showList={showList}
      selected={t.id === selectedId}
      expanded={t.id === expandedId}
      inline={t.id === expandedId ? renderInline(t) : undefined}
      {...handlers}
    />
  )
  const folded = !!g.folded
  const body = sortable ? (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="tasks">{g.tasks.map((t) => row(t, SortableTask))}</ul>
      </SortableContext>
    </DndContext>
  ) : (
    <ul className="tasks">{g.tasks.map((t) => row(t, TaskItem))}</ul>
  )
  const titleText = (
    <>
      {g.title} <span className="count">{g.tasks.length}</span>
    </>
  )
  return (
    <section className={`group${folded ? ' folded' : ''}`}>
      {g.title && (
        <div className="group-head">
          {g.onFold ? (
            <button type="button" className={`group-title fold${g.tone ? ` ${g.tone}` : ''}`} onClick={g.onFold} aria-expanded={!folded}>
              <Chevron open={!folded} />{titleText}
            </button>
          ) : (
            <h3 className={`group-title${g.tone ? ` ${g.tone}` : ''}`}>{titleText}</h3>
          )}
          {g.action && <span className="group-action">{g.action}</span>}
        </div>
      )}
      {g.onFold ? <Collapsible open={!folded}>{body}</Collapsible> : body}
    </section>
  )
}

export function TaskList(props: Props) {
  const { groups, lists, sortable, empty } = props
  const byId = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists])
  const total = groups.reduce((n, g) => n + g.tasks.length, 0)
  if (!total) return <div className="empty">{empty}</div>
  return (
    <div className="groups">
      {groups.filter((g) => g.tasks.length).map((g) => (
        <GroupBlock key={g.key} g={g} byId={byId} sortable={sortable && g.key !== 'done'} props={props} />
      ))}
    </div>
  )
}
