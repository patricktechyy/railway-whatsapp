import { Collapsible } from './Collapsible'
import { colorClass } from '../listColor'
import { ListMenu } from './ListMenu'
import { memo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Group, List, Me, View } from '../types'
import { Mark, WhatsUpLogo } from './Login'
import { Icon } from './Icon'

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 272

export interface Counts {
  today: number
  overdue: number
  upcoming: number
  all: number
  inbox: number
  lists: Record<string, number>
}

interface Props {
  me: Me
  view: View
  lists: List[]
  tags: string[]
  counts: Counts
  online: boolean
  open: boolean // phone drawer
  collapsed: boolean // desktop: hidden behind the rail
  peek: boolean // desktop: collapsed, but hovered open as an overlay
  onCollapse: () => void
  onPeek: (on: boolean) => void
  onReorderLists: (ids: string[]) => void
  onNavigate: (v: View) => void
  onNewList: () => void
  onEditList: (l: List) => void
  onDeleteList: (l: List) => void
  onSettings: () => void
  onSignOut: () => void
  onWhatsApp?: () => void // back to Whats Up (your chats)
  listsCollapsed: boolean // the Lists section is rolled up
  listsShowAll: boolean // "View more" is on
  onListsUi: (p: { listsCollapsed?: boolean; listsShowAll?: boolean }) => void
  groups: Group[] | null
  onNewGroup: () => void
}

/** The sidebar shows this many lists before "View more". */
export const LISTS_SHOWN = 4

const same = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b)
/** Which of the page groups (Plan, Study, Tasks, You) you rolled up, on this device. */
const NAV_KEY = 'todo-nav-groups'

export const SidebarIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="3" /><path d="M8 3.5v13M4.8 7h1M4.8 9.5h1" /></svg>
)

/** A list row that can be dragged up and down to reorder (pointer or long-press on touch). */
function SortableListRow({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const { role: _r, tabIndex: _t, ...aria } = attributes
  return (
    <li
      ref={setNodeRef}
      className={`nav-list-row${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // right-click a list for the same Edit / Delete menu as its ⋯ button
      onContextMenu={(e) => { const b = e.currentTarget.querySelector<HTMLButtonElement>('[data-list-menu]'); if (b) { e.preventDefault(); b.click() } }}
      {...aria}
      {...listeners}
    >
      {children}
    </li>
  )
}

/** The 6px strip on the sidebar's right edge: drag, arrow keys, double-click to reset. */
export function ResizeHandle({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const clamp = (w: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)))
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, w: width }
    document.body.classList.add('resizing')
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onResize(clamp(start.current.w + e.clientX - start.current.x))
  }
  const up = () => {
    start.current = null
    document.body.classList.remove('resizing')
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      onResize(clamp(width + (e.key === 'ArrowRight' ? 16 : -16)))
    }
  }
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT)}
      onKeyDown={key}
    />
  )
}

const ICONS: Record<string, ReactNode> = {
  today: <><circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" /></>,
  upcoming: <><rect x="3" y="4" width="14" height="13" rx="3" /><path d="M3 8h14M7 2.5v3M13 2.5v3M7 11.5h2" /></>,
  calendar: <><rect x="3" y="4" width="14" height="13" rx="3" /><path d="M3 8h14M7 2.5v3M13 2.5v3M6.5 11h1M9.5 11h1M12.5 11h1M6.5 14h1M9.5 14h1" /></>,
  all: <><path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9" /><circle cx="4" cy="5.5" r="1" /><circle cx="4" cy="10" r="1" /><circle cx="4" cy="14.5" r="1" /></>,
  inbox: <><path d="M3 11.5 5 4.5h10l2 7v4H3z" /><path d="M3 11.5h4l1 2h4l1-2h4" /></>,
  completed: <><circle cx="10" cy="10" r="7" /><path d="M6.8 10.2 9 12.4l4.3-4.6" /></>,
  stats: <><path d="M4 16V9M8.5 16V4M13 16v-5M17 16H3" /></>,
  admin: <><path d="M10 2.5 16 5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5z" /><path d="M7.5 10 9.3 11.8 12.8 8.2" /></>,
  study: <><path d="M10 5.5c-1.8-1.3-4-1.8-6.5-1.5v11c2.5-.3 4.7.2 6.5 1.5 1.8-1.3 4-1.8 6.5-1.5v-11c-2.5-.3-4.7.2-6.5 1.5z" /><path d="M10 5.5v11" /></>,
  exams: <><path d="M5.5 2.5h6l3 3v12h-9z" /><path d="M11.5 2.5v3h3M7.8 10.6l1.6 1.6 3-3.2M7.8 15h4.4" /></>,
}

function Item({ icon, label, count, danger, active, onClick }: { icon: ReactNode; label: ReactNode; count?: number; danger?: boolean; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button className={`nav-item${active ? ' on' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        {!!count && <span className={`nav-count${danger ? ' danger' : ''}`}>{count}</span>}
      </button>
    </li>
  )
}

export const Sidebar = memo(function Sidebar({ me, view, lists, tags, counts, online, open, collapsed, peek, onCollapse, onPeek, onReorderLists, onNavigate, onNewList, onEditList, onDeleteList, onSettings, onSignOut, onWhatsApp, listsCollapsed, listsShowAll, onListsUi, groups, onNewGroup }: Props) {
  const svg = (k: string) => <svg viewBox="0 0 20 20" aria-hidden="true">{ICONS[k]}</svg>
  const [shut, setShut] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem(NAV_KEY) || '{}') || {} } catch { return {} } })
  const toggleGroup = (id: string) => setShut((x) => {
    const next = { ...x, [id]: !x[id] }
    try { localStorage.setItem(NAV_KEY, JSON.stringify(next)) } catch {}
    return next
  })
  const go = (v: View) => () => onNavigate(v)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  )
  const reorder = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const ids = lists.map((l) => l.id)
    onReorderLists(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))))
  }
  return (
    <nav
      className={`sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}${peek ? ' peek' : ''}`}
      aria-label="Main"
      onMouseEnter={() => collapsed && onPeek(true)}
      onMouseLeave={() => collapsed && onPeek(false)}
    >
      <div className="side-head">
        <Mark size={34} />
        <div className="side-brand">
          <b>Gavin's Todolist</b>
          <span className="side-user">
            <i className={`dot${online ? ' ok' : ''}`} title={online ? 'Synced' : 'Reconnecting…'} />
            {me.name}
          </span>
        </div>
        <button className="icon-btn sm collapse-btn" onClick={onCollapse} aria-label={collapsed ? 'Keep sidebar open' : 'Hide sidebar'} title={collapsed ? 'Keep sidebar open ([)' : 'Hide sidebar ([)'}>
          <SidebarIcon />
        </button>
      </div>

      {/* the pages, in groups you can roll up like Lists: plan your days → study → your tasks → you */}
      {(() => {
        const item = (kind: View['kind'], label: string, extra: { count?: number; danger?: boolean } = {}) => {
          const v = { kind } as View
          return { key: kind, active: same(view, v), node: <Item key={kind} icon={svg(kind)} label={label} {...extra} active={same(view, v)} onClick={go(v)} /> }
        }
        const personalize = {
          key: 'board', active: view.kind === 'board',
          node: (
            <li key="board">
              <button className={`nav-item personalize-btn${view.kind === 'board' ? ' on' : ''}`} onClick={go({ kind: 'board' })} aria-current={view.kind === 'board' ? 'page' : undefined}>
                <span className="nav-icon"><Icon name="palette" /></span>
                <span className="nav-label">Personalize It</span>
              </button>
            </li>
          ),
        }
        const groups: { id: string; label: string; items: { key: string; active: boolean; node: ReactNode }[]; badge?: { n: number; danger?: boolean } }[] = [
          { id: 'plan', label: 'Plan', items: [item('today', 'Today', { count: counts.today + counts.overdue, danger: counts.overdue > 0 }), item('upcoming', 'Upcoming', { count: counts.upcoming }), item('calendar', 'Calendar')], badge: { n: counts.today + counts.overdue, danger: counts.overdue > 0 } },
          { id: 'study', label: 'Study', items: [item('study', 'Study planner'), item('exams', 'Exams')] },
          { id: 'tasks', label: 'Tasks', items: [item('all', 'All tasks', { count: counts.all }), item('inbox', 'No list', { count: counts.inbox }), item('completed', 'Completed')], badge: { n: counts.all } },
          { id: 'you', label: 'You', items: [item('stats', 'Stats'), personalize, ...(me.admin ? [item('admin', 'Admin')] : [])] },
        ]
        return groups.map((g) => {
          const closed = !!shut[g.id]
          const active = g.items.find((x) => x.active)
          return (
            <div className="nav-group" key={g.id}>
              <div className="nav-section nav-group-head">
                <button type="button" className="section-toggle" onClick={() => toggleGroup(g.id)} aria-expanded={!closed} aria-controls={`nav-${g.id}`} title={closed ? `Show ${g.label}` : `Roll up ${g.label}`}>
                  <span>{g.label}</span>
                  <svg className={`chev${closed ? '' : ' open'}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
                  {closed && !!g.badge?.n && <span className={`section-count${g.badge.danger ? ' danger' : ''}`}>{g.badge.n}</span>}
                </button>
              </div>
              {/* rolled up, the page you're on stays in view */}
              {closed && active && <ul className="nav">{active.node}</ul>}
              <Collapsible open={!closed}>
                <ul className="nav" id={`nav-${g.id}`} aria-label={g.label}>{g.items.map((x) => x.node)}</ul>
              </Collapsible>
            </div>
          )
        })
      })()}

      <div className="nav-section lists-head">
        <button type="button" className="section-toggle" onClick={() => onListsUi({ listsCollapsed: !listsCollapsed })} aria-expanded={!listsCollapsed} aria-controls="side-lists" title={listsCollapsed ? 'Show your lists' : 'Hide your lists'}>
          <span>Lists</span>
          <svg className={`chev${listsCollapsed ? '' : ' open'}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
          {listsCollapsed && lists.length > 0 && <span className="section-count">{lists.length}</span>}
        </button>
        <button className="icon-btn sm" onClick={onNewList} aria-label="New list">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
        </button>
      </div>
      {(() => {
        // the first few lists, plus the one you're looking at (so the current page is never hidden)
        const activeIdx = view.kind === 'list' ? lists.findIndex((l) => l.id === view.id) : -1
        const lift = !listsShowAll && activeIdx >= LISTS_SHOWN
        const top = lists.slice(0, LISTS_SHOWN).concat(lift ? [lists[activeIdx]] : [])
        const rest = lists.slice(LISTS_SHOWN).filter((l) => !(lift && l.id === lists[activeIdx].id))
        const row = (l: List) => (
          <SortableListRow key={l.id} id={l.id}>
            <button className={`nav-item${same(view, { kind: 'list', id: l.id }) ? ' on' : ''}`} onClick={go({ kind: 'list', id: l.id })}>
              <span className="nav-icon emoji">{l.emoji}<i className={`swatch ${colorClass(l.color)}`} aria-hidden="true" /></span>
              <span className="nav-label">{l.name}</span>
              {!!counts.lists[l.id] && <span className="nav-count">{counts.lists[l.id]}</span>}
            </button>
            <ListMenu list={l} onEdit={() => onEditList(l)} onDelete={() => onDeleteList(l)} />
          </SortableListRow>
        )
        return (
          <Collapsible open={!listsCollapsed}>
            <div id="side-lists">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
                <SortableContext items={[...top, ...rest].map((l) => l.id)} strategy={verticalListSortingStrategy}>
                  <ul className="nav" aria-label="Lists">{top.map(row)}</ul>
                  {rest.length > 0 && (
                    <Collapsible open={listsShowAll} className="more-lists">
                      <ul className="nav" aria-label="More lists">{rest.map(row)}</ul>
                    </Collapsible>
                  )}
                </SortableContext>
              </DndContext>
              {lists.length > LISTS_SHOWN && (
                <button type="button" className="view-more" onClick={() => onListsUi({ listsShowAll: !listsShowAll })} aria-expanded={listsShowAll}>
                  <svg className={`chev${listsShowAll ? ' up' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg>
                  {listsShowAll ? 'Show less' : `View more (${rest.length})`}
                </button>
              )}
              {lists.length === 0 && <p className="side-empty">No lists yet.</p>}
            </div>
          </Collapsible>
        )
      })()}

      {/* groups: the admin makes them; people only see the section once they're in one */}
      {(me.admin || !!groups?.length) && (
        <>
        <div className="nav-section lists-head">
          <span className="section-label">Groups</span>
          {me.admin && (
            <button className="icon-btn sm" onClick={onNewGroup} aria-label="New group" title="New group">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
            </button>
          )}
        </div>
        <ul className="nav" aria-label="Groups">
          {(groups || []).map((g) => {
            const mine = g.tasks.filter((t) => !t.done && t.assignee === me.username).length
            const open = g.tasks.filter((t) => !t.done).length
            return (
              <li key={g.id}>
                <button className={`nav-item${same(view, { kind: 'group', id: g.id }) ? ' on' : ''}`} onClick={go({ kind: 'group', id: g.id })} title={`${g.members.length} people`}>
                  <span className="nav-icon emoji">{g.emoji}</span>
                  <span className="nav-label">{g.name}</span>
                  {!!open && <span className={`nav-count${mine ? ' mine' : ''}`} title={mine ? `${mine} for you` : undefined}>{open}</span>}
                </button>
              </li>
            )
          })}
          {groups && groups.length === 0 && <li><p className="side-empty">No groups yet.</p></li>}
        </ul>
        </>
      )}

      {tags.length > 0 && (
        <>
          <div className="nav-section"><span className="section-label">Tags</span></div>
          <div className="tag-cloud">
            {tags.map((t) => (
              <button key={t} className={`badge${view.kind === 'tag' && view.tag === t ? ' ok' : ''}`} onClick={go({ kind: 'tag', tag: t })}>#{t}</button>
            ))}
          </div>
        </>
      )}

      {onWhatsApp && (
        <button className="btn ghost full wa-btn side-wa" onClick={onWhatsApp} title={me.home.startsWith('/u/') ? 'Back to your Whats Up chats' : 'Back to the admin page'} aria-label={me.home.startsWith('/u/') ? 'Back to your Whats Up chats' : 'Back to the admin page'}>
          <WhatsUpLogo className="wa-logo" size={20} />
          <span className="wa-logo-label">{me.home.startsWith('/u/') ? 'Whats Up' : 'Whats Up admin'}</span>
        </button>
      )}
      <div className="side-foot">
        <button className="btn quiet" onClick={onSettings}>
          <svg viewBox="0 0 20 20" aria-hidden="true" width="18" height="18"><circle cx="10" cy="10" r="2.6" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></svg>
          Settings
        </button>
        <button className="btn quiet" onClick={onSignOut}>Sign out</button>
      </div>
    </nav>
  )
})
