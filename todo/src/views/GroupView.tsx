import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { formatDue, todayKey } from '../dates'
import { parseQuickAdd } from '../quickadd'
import { Check } from '../components/TaskItem'
import { Dialog } from '../components/Dialogs'
import { Collapsible } from '../components/Collapsible'
import type { Group, GroupTask, Person } from '../types'
import type { GroupTaskInput } from '../useGroups'
import { Select } from '../components/Select'

type Actions = {
  addTask: (gid: string, b: GroupTaskInput) => Promise<GroupTask | null>
  updateTask: (gid: string, tid: string, b: GroupTaskInput) => Promise<void>
  deleteTask: (gid: string, tid: string) => Promise<void>
  clearDone: (gid: string) => Promise<void>
}

const initials = (n: string) => n.trim().split(/\s+/).map((w) => Array.from(w)[0] || '').join('').slice(0, 2).toUpperCase() || '?'

export function Avatars({ people, max = 6 }: { people: Person[]; max?: number }) {
  return (
    <span className="g-avatars">
      {people.slice(0, max).map((p) => <span key={p.username} className="g-av" title={p.name}>{initials(p.name)}</span>)}
      {people.length > max && <span className="g-av more">+{people.length - max}</span>}
    </span>
  )
}

/** A group's shared list: add, tick off, give to someone, edit. Everyone in the group sees the same thing, live. */
export function GroupView({ group: g, me, actions, onEdit }: { group: Group; me: string; actions: Actions; onEdit: () => void }) {
  const [text, setText] = useState('')
  const [assignee, setAssignee] = useState<string>('')
  const [filter, setFilter] = useState<'all' | 'mine'>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const nameOf = useMemo(() => new Map(g.members.map((m) => [m.username, m.name])), [g.members])
  const who = (u: string | null) => (u ? (u === me ? 'you' : nameOf.get(u) || u) : '')
  const today = todayKey()

  const parsed = text.trim() ? parseQuickAdd(text, []) : null
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!parsed?.title) return
    const t = await actions.addTask(g.id, { title: parsed.title, due: parsed.due ?? null, time: parsed.time ?? null, priority: parsed.priority ?? 0, assignee: assignee || null })
    if (t) setText('')
  }

  const shown = g.tasks.filter((t) => filter === 'all' || t.assignee === me)
  const open = shown.filter((t) => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || a.order - b.order)
  const done = shown.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
  const mineCount = g.tasks.filter((t) => !t.done && t.assignee === me).length

  const row = (t: GroupTask) => (
    <li key={t.id} className={`g-task${t.done ? ' done' : ''}${openId === t.id ? ' open' : ''}`}>
      <Check done={t.done} label={t.title} onToggle={() => actions.updateTask(g.id, t.id, { done: !t.done })} />
      {openId === t.id ? (
        <GroupTaskEditor task={t} members={g.members} onSave={(b) => actions.updateTask(g.id, t.id, b)} onDelete={() => { setOpenId(null); actions.deleteTask(g.id, t.id) }} onClose={() => setOpenId(null)} />
      ) : (
        <button type="button" className="g-body" onClick={() => setOpenId(t.id)}>
          <span className="g-title">{t.title}</span>
          <span className="g-meta">
            {t.due && <span className={`meta due${!t.done && t.due < today ? ' overdue' : ''}`}>{formatDue(t)}</span>}
            {t.assignee ? <span className={`meta g-who${t.assignee === me ? ' me' : ''}`}>→ {who(t.assignee)}</span> : <span className="meta">Anyone</span>}
            {t.done && t.doneBy && <span className="meta">done by {who(t.doneBy)}</span>}
            {!t.done && t.by !== me && <span className="meta muted">added by {who(t.by)}</span>}
          </span>
        </button>
      )}
    </li>
  )

  return (
    <div className="group-page">
      <div className="g-bar">
        <button type="button" className="g-members" onClick={onEdit} title="People in this group">
          <Avatars people={g.members} />
          <span>{g.members.length} {g.members.length === 1 ? 'person' : 'people'}</span>
        </button>
        <div className="seg sm" role="radiogroup" aria-label="Show">
          <button role="radio" aria-checked={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>Everything</button>
          <button role="radio" aria-checked={filter === 'mine'} className={filter === 'mine' ? 'on' : ''} onClick={() => setFilter('mine')}>Mine{mineCount ? ` (${mineCount})` : ''}</button>
        </div>
      </div>

      <form className="g-add" onSubmit={add}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${g.name}…`} aria-label="New group task" maxLength={300} />
        <Select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="For">
          <option value="">Anyone</option>
          {g.members.map((m) => <option key={m.username} value={m.username}>{m.username === me ? 'Me' : m.name}</option>)}
        </Select>
        <button className="btn" disabled={!parsed?.title}>Add</button>
      </form>
      {parsed?.due && <p className="help g-hint">{formatDue({ due: parsed.due, time: parsed.time ?? null })}</p>}

      {open.length === 0 && done.length === 0 ? (
        <div className="empty">{filter === 'mine' ? 'Nothing for you here.' : 'No tasks yet.'}</div>
      ) : (
        <>
          {open.length > 0 && <ul className="tasks g-list">{open.map(row)}</ul>}
          {done.length > 0 && (
            <section className={`group${doneOpen ? '' : ' folded'}`}>
              <div className="group-head">
                <button type="button" className="group-title fold" onClick={() => setDoneOpen(!doneOpen)} aria-expanded={doneOpen}>
                  <svg className={`chev${doneOpen ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
                  Done <span className="count">{done.length}</span>
                </button>
                <span className="group-action"><button className="btn quiet sm" onClick={() => { if (confirm(`Delete ${done.length} finished task${done.length === 1 ? '' : 's'} for everyone in the group?`)) actions.clearDone(g.id) }}>Clear</button></span>
              </div>
              <Collapsible open={doneOpen}><ul className="tasks g-list">{done.map(row)}</ul></Collapsible>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function GroupTaskEditor({ task, members, onSave, onDelete, onClose }: { task: GroupTask; members: Person[]; onSave: (b: GroupTaskInput) => void; onDelete: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const save = (b: GroupTaskInput) => onSave(b)
  return (
    <div className="g-edit">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== task.title && save({ title: title.trim() })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') onClose() }} aria-label="Title" autoFocus />
      <textarea className="input" rows={2} value={notes} placeholder="Notes" onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== task.notes && save({ notes })} aria-label="Notes" />
      <div className="g-edit-row">
        <input className="input sm" type="date" value={task.due || ''} onChange={(e) => save({ due: e.target.value || null })} aria-label="Date" />
        <input className="input sm" type="time" value={task.time || ''} disabled={!task.due} onChange={(e) => save({ time: e.target.value || null })} aria-label="Time" />
        <Select className="input sm" value={task.assignee || ''} onChange={(e) => save({ assignee: e.target.value || null })} aria-label="For">
          <option value="">Anyone</option>
          {members.map((m) => <option key={m.username} value={m.username}>{m.name}</option>)}
        </Select>
        <span className="spacer" />
        <button type="button" className="btn quiet sm danger-text" onClick={() => { if (confirm('Delete this task for everyone in the group?')) onDelete() }}>Delete</button>
        <button type="button" className="btn ghost sm" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

const EMOJIS = ['👥', '🧪', '📚', '🏠', '💼', '🎉', '⚽', '🎵', '✈️', '🛒', '💡', '❤️']

/** Make a group, or change one: its name, icon and who's in it. */
export function GroupDialog({ group, me, onSave, onLeave, onDelete, onClose }: {
  group?: Group
  me: string
  onSave: (v: { name: string; emoji: string; members?: string[] }) => void
  onLeave?: () => void
  onDelete?: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(group?.name || '')
  const [emoji, setEmoji] = useState(group?.emoji || '👥')
  const [members, setMembers] = useState<string[]>(group ? group.members.map((m) => m.username) : [me])
  const [people, setPeople] = useState<Person[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { api<Person[]>('/people').then(setPeople).catch(() => setPeople([])) }, [])
  const owner = !group || group.owner === me
  const wasIn = new Set(group?.members.map((m) => m.username) || [])
  const toggle = (u: string) => setMembers((ms) => (ms.includes(u) ? ms.filter((x) => x !== u) : [...ms, u]))
  const list = (people || []).filter((p) => p.username !== me && (!q || p.name.toLowerCase().includes(q.toLowerCase()) || p.username.includes(q.toLowerCase())))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    // only send people if they changed, so a rename doesn't undo someone else's edit
    const same = group && members.length === wasIn.size && members.every((m) => wasIn.has(m))
    onSave({ name: name.trim(), emoji, ...(same ? {} : { members }) })
    onClose()
  }
  return (
    <Dialog title={group ? group.name : 'New group'} onClose={onClose} className="group-dialog">
      <form onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus={!group} required placeholder="e.g. Physics project" />
        </label>
        <div className="field">
          <span className="label">Icon</span>
          <div className="emoji-grid" role="radiogroup" aria-label="Icon">
            {EMOJIS.map((x) => <button type="button" key={x} role="radio" aria-checked={emoji === x} className={emoji === x ? 'on' : ''} onClick={() => setEmoji(x)}>{x}</button>)}
          </div>
        </div>
        <div className="field">
          <span className="label">People</span>
          {(people?.length || 0) > 8 && <input className="input sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone" aria-label="Find someone" />}
          <ul className="g-people">
            {people === null && <li className="muted">Loading…</li>}
            {list.map((p) => {
              const on = members.includes(p.username)
              const locked = on && wasIn.has(p.username) && !owner
              return (
                <li key={p.username}>
                  <label className={locked ? 'locked' : ''}>
                    <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(p.username)} />
                    <span className="g-av">{initials(p.name)}</span>
                    <span>{p.name}<small>@{p.username}{group?.owner === p.username ? ' · made this group' : ''}</small></span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
        <div className="dialog-actions">
          {group && onDelete && owner && <button type="button" className="btn danger" onClick={() => { if (confirm(`Delete “${group.name}” and its tasks for everyone?`)) { onClose(); onDelete() } }}>Delete group</button>}
          {group && onLeave && <button type="button" className="btn quiet" onClick={() => { if (confirm(`Leave “${group.name}”?`)) { onClose(); onLeave() } }}>Leave</button>}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!name.trim()}>{group ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </Dialog>
  )
}
