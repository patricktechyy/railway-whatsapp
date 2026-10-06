import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import { Switch } from '../components/Switch'
import { toast } from '../components/Toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { formatDay, formatTime } from '../dates'
import { describeRepeat } from '../repeat'
import type { Repeat } from '../types'
import { Select } from '../components/Select'

interface Person {
  username: string
  name: string
  open: number
  done: number
  overdue: number
  lists: number
  lastSeen: number | null
  devices: number
  waReminders: boolean
  tourDone: boolean
  tz: string | null
  bot?: boolean
  whatsapp?: { exists?: boolean; connected?: boolean; phone?: string; status?: string; error?: string }
}
interface Announcement { id: string; title: string; body: string; to: string; at: number; by: string }
interface Account { username: string; name: string; exists?: boolean; connected?: boolean; status?: string; phone?: string }
interface Bot { username: string; name: string; connected: boolean; status: string; phone: string }
interface Settings {
  configured: boolean
  whatsapp: { reminders: boolean; share: boolean; inbox: boolean; buddy: boolean }
  announcements: Announcement[]
  bot: Bot | null
  botFromEnv: boolean
  accounts: Account[]
}
interface Overview { people: number; active7: number; open: number; overdue: number; doneWeek: number; notifications: number; assignments: number; assignedOpen: number }
type St = 'todo' | 'doing' | 'done' | 'removed'
interface Assignment {
  id: string
  title: string
  notes: string
  due: string | null
  time: string | null
  priority: number
  repeat: Repeat | null
  steps: number
  at: number
  byName: string
  to: string[]
  people: { username: string; name: string; status: St; doneAt: number | null; rounds: number }[]
  counts: Record<St, number>
}

type Tab = 'overview' | 'tasks' | 'people' | 'announce' | 'whatsapp'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'people', label: 'People' },
  { key: 'announce', label: 'Announcements' },
  { key: 'whatsapp', label: 'WhatsApp' },
]

const FEATURES: { key: keyof Settings['whatsapp']; label: string; help: string }[] = [
  { key: 'reminders', label: 'Reminders on WhatsApp', help: 'People can get their reminders on WhatsApp too.' },
  { key: 'share', label: 'Share a task to a chat', help: 'Send a task to a chat from your own WhatsApp.' },
  { key: 'inbox', label: 'Add tasks from WhatsApp', help: 'Message the bot “add buy milk 5pm” to add a task.' },
  { key: 'buddy', label: 'WhatsApp Buddy 🤖', help: 'Task messages, daily briefs and replies like “done”. Needs reminders on WhatsApp.' },
]

const ST_LABEL: Record<St, string> = { todo: 'Not started', doing: 'In progress', done: 'Completed', removed: 'Deleted it' }
const PRIORITIES = ['None', 'Low', 'Medium', 'High']
const REPEATS: { label: string; value: Repeat | null }[] = [
  { label: 'Never', value: null },
  { label: 'Every day', value: { freq: 'day', interval: 1 } },
  { label: 'Every week', value: { freq: 'week', interval: 1 } },
  { label: 'Every month', value: { freq: 'month', interval: 1 } },
]

function ago(ts: number | null) {
  if (!ts) return 'Never'
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 2) return 'Just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(ts).toLocaleDateString()
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Red / yellow / green (and grey for deleted) bar of where everyone is with one assignment. */
function ProgressStack({ counts, total }: { counts: Record<St, number>; total: number }) {
  return (
    <div className="assign-bar" role="img" aria-label={(['done', 'doing', 'todo', 'removed'] as St[]).map((s) => `${counts[s]} ${ST_LABEL[s].toLowerCase()}`).join(', ')}>
      {(['done', 'doing', 'todo', 'removed'] as St[]).map((s) => counts[s] > 0 && <span key={s} className={`seg-${s}`} style={{ flexGrow: counts[s] / Math.max(1, total) }} />)}
    </div>
  )
}

/**
 * For the admin only. Overview numbers, giving people tasks (and following how they're
 * getting on with those, and only those), people, announcements and the WhatsApp link.
 * Nobody's own tasks are ever shown here: only counts, and the tasks you gave them.
 */
export function AdminView({ me }: { me: string }) {
  const [tab, setTab] = useState<Tab>(() => { try { return (sessionStorage.getItem('todo-admin-tab') as Tab) || 'overview' } catch { return 'overview' } })
  const go = (t: Tab) => { setTab(t); try { sessionStorage.setItem('todo-admin-tab', t) } catch {} }
  const [people, setPeople] = useState<Person[] | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [assigned, setAssigned] = useState<Assignment[] | null>(null)
  const [pickFor, setPickFor] = useState<string[] | null>(null) // People → "Give a task" preselects them
  const [announceTo, setAnnounceTo] = useState('all')

  const load = () => {
    api<Person[]>('/admin/people').then(setPeople).catch((e) => toast(e.message))
    api<Settings>('/admin/settings').then(setSettings).catch((e) => toast(e.message))
    api<Overview>('/admin/overview').then(setOverview).catch(() => {})
    api<Assignment[]>('/admin/assignments').then(setAssigned).catch(() => {})
  }
  useEffect(load, [])
  // people starting, finishing or deleting tasks you gave them: the server says so straight away
  // (and every 30 s as a fallback), so the progress here is always current
  useEffect(() => {
    let wait: number | undefined
    const refresh = () => {
      clearTimeout(wait)
      wait = window.setTimeout(() => {
        api<Assignment[]>('/admin/assignments').then(setAssigned).catch(() => {})
        api<Overview>('/admin/overview').then(setOverview).catch(() => {})
      }, 250) // a burst of changes → one refresh
    }
    const onEv = (e: Event) => { if ((e as CustomEvent).detail?.type === 'assignment') refresh() }
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 30000)
    window.addEventListener('todo:event', onEv)
    return () => { clearInterval(t); clearTimeout(wait); window.removeEventListener('todo:event', onEv) }
  }, [])

  return (
    <div className="admin">
      <div className="seg admin-tabs" role="tablist" aria-label="Admin sections">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => go(t.key)}>
            {t.label}
            {t.key === 'tasks' && !!assigned?.length && <span className="tab-count">{assigned.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab overview={overview} assigned={assigned} onGo={go} onRefresh={load} />}
      {tab === 'tasks' && (
        <TasksTab
          me={me}
          people={people}
          settings={settings}
          assigned={assigned}
          preselect={pickFor}
          onPreselectUsed={() => setPickFor(null)}
          onChanged={load}
        />
      )}
      {tab === 'people' && (
        <PeopleTab
          people={people}
          onRefresh={load}
          onGive={(u) => { setPickFor([u]); go('tasks') }}
          onAnnounce={(u) => { setAnnounceTo(u); go('announce') }}
        />
      )}
      {tab === 'announce' && <AnnounceTab people={people} settings={settings} to={announceTo} setTo={setAnnounceTo} onChanged={load} />}
      {tab === 'whatsapp' && <WhatsAppTab settings={settings} setSettings={setSettings} onChanged={load} />}
    </div>
  )
}

// ----------------------------------------------------------------- overview
function Tile({ label, value, note, tone, onClick }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'ok' | 'danger'; onClick?: () => void }) {
  const inner = <><span className="tile-label">{label}{onClick && <span className="tile-go"> →</span>}</span><span className="tile-value">{value}</span>{note && <span className="tile-note">{note}</span>}</>
  return onClick
    ? <button type="button" className={`tile link${tone ? ` ${tone}` : ''}`} onClick={onClick}>{inner}</button>
    : <div className={`tile${tone ? ` ${tone}` : ''}`}>{inner}</div>
}

function OverviewTab({ overview: o, assigned, onGo, onRefresh }: { overview: Overview | null; assigned: Assignment[] | null; onGo: (t: Tab) => void; onRefresh: () => void }) {
  if (!o) return <p className="muted">Loading…</p>
  const recent = (assigned || []).slice(0, 4)
  return (
    <>
      <div className="tiles admin-tiles">
        <Tile label="People" value={o.people} note={`${o.active7} active this week`} onClick={() => onGo('people')} />
        <Tile label="Open tasks" value={o.open} note={o.overdue ? <span className="bad">{o.overdue} overdue</span> : 'None overdue'} tone={o.overdue ? 'danger' : undefined} />
        <Tile label="Done this week" value={o.doneWeek} note="By everyone" tone="ok" />
        <Tile label="Notifications on" value={o.notifications} note={`of ${plural(o.people, 'person', 'people')}`} />
        <Tile label="Tasks you gave" value={o.assignments} note={`${o.assignedOpen} still open`} onClick={() => onGo('tasks')} />
      </div>
      <section className="card">
        <div className="chart-head">
          <div>
            <h2>Recently given</h2>
          </div>
          <div className="row">
            <button className="btn ghost sm" onClick={onRefresh}>Refresh</button>
            <button className="btn sm" onClick={() => onGo('tasks')}>📌 Give a task</button>
          </div>
        </div>
        {recent.length === 0 ? <p className="muted admin-empty">You haven’t given anyone a task yet.</p> : (
          <ul className="assign-mini">
            {recent.map((a) => (
              <li key={a.id}>
                <span className="assign-mini-title"><b>{a.title}</b><small>{plural(a.to.length, 'person', 'people')} · {ago(a.at)}</small></span>
                <ProgressStack counts={a.counts} total={a.to.length} />
                <span className="assign-mini-num">{a.counts.done}/{a.to.length}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

// -------------------------------------------------------------------- tasks
function TasksTab({ me, people, settings, assigned, preselect, onPreselectUsed, onChanged }: {
  me: string
  people: Person[] | null
  settings: Settings | null
  assigned: Assignment[] | null
  preselect: string[] | null
  onPreselectUsed: () => void
  onChanged: () => void
}) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [due, setDue] = useState('')
  const [time, setTime] = useState('')
  const [priority, setPriority] = useState(0)
  const [repeat, setRepeat] = useState(0)
  const [steps, setSteps] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [tags, setTags] = useState('')
  const [everyone, setEveryone] = useState(true)
  const [picked, setPicked] = useState<string[]>([])
  const [find, setFind] = useState('')
  const [whatsapp, setWhatsapp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null) // assignment showing everyone's progress
  const [confirm, setConfirm] = useState<Assignment | null>(null)

  useEffect(() => {
    if (!preselect) return
    setEveryone(false)
    setPicked(preselect)
    onPreselectUsed()
    document.querySelector<HTMLInputElement>('.assign-form input[name="title"]')?.focus()
  }, [preselect]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase()
    return (people || []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.username.includes(q))
  }, [people, find])
  const count = everyone ? (people || []).filter((p) => p.username !== me).length : picked.length // "everyone" leaves you out
  const waOn = !!settings?.whatsapp.reminders
  const urlOk = !linkUrl.trim() || /^https?:\/\/\S+\.\S+/.test(linkUrl.trim())
  const can = !!title.trim() && count > 0 && urlOk && (!time || !!due) && !busy

  const reset = () => { setTitle(''); setNotes(''); setDue(''); setTime(''); setPriority(0); setRepeat(0); setSteps(''); setLinkUrl(''); setTags('') }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!can) return
    setBusy(true)
    try {
      const url = linkUrl.trim()
      const r = await api<{ assignment: Assignment; pushed: number; whatsapp: number; failed: { username: string; error: string }[] }>('/admin/assignments', 'POST', {
        to: everyone ? 'all' : picked,
        whatsapp,
        task: {
          title: title.trim(), notes: notes.trim(), due: due || null, time: due && time ? time : null, priority,
          repeat: REPEATS[repeat].value,
          subtasks: steps.split('\n').map((x) => x.trim()).filter(Boolean),
          links: url ? [{ url, title: '' }] : [],
          tags: tags.split(/[\s,]+/).map((x) => x.replace(/^#/, '')).filter(Boolean),
        },
      })
      const n = r.assignment.to.length
      toast(`Given to ${plural(n, 'person', 'people')}${r.pushed ? ` · ${plural(r.pushed, 'notification')}` : ''}${r.whatsapp ? ` · ${r.whatsapp} on WhatsApp` : ''}${r.failed.length ? ` · ${r.failed.length} couldn’t get it` : ''}`)
      reset()
      setOpen(r.assignment.id)
      onChanged()
    } catch (err: any) { toast(err.message) }
    setBusy(false)
  }
  const remind = async (a: Assignment) => {
    try {
      const r = await api<{ people: number; pushed: number; whatsapp: number }>(`/admin/assignments/${a.id}/remind`, 'POST', { whatsapp: waOn })
      const how = [r.pushed && plural(r.pushed, 'notification'), r.whatsapp && `${r.whatsapp} on WhatsApp`].filter(Boolean).join(', ')
      toast(r.people ? `Reminded ${plural(r.people, 'person', 'people')}${how ? ` (${how})` : ''}` : 'Everyone’s finished it')
    } catch (e: any) { toast(e.message) }
  }
  const remove = async (a: Assignment, withdraw: boolean) => {
    setConfirm(null)
    try {
      const r = await api<{ removed: number; people?: number }>(`/admin/assignments/${a.id}${withdraw ? '?withdraw=1' : ''}`, 'DELETE')
      toast(withdraw ? `Taken back from ${plural(r.people ?? 0, 'person', 'people')} (${r.removed} task${r.removed === 1 ? '' : 's'} removed)` : 'Removed here. People keep their copies.')
      onChanged()
    } catch (e: any) { toast(e.message) }
  }

  return (
    <div className="admin-cols assign-cols">
      <section className="card">
        <h2>Give people a task</h2>
        <p className="help">It shows up in their list marked 📌, with a notification.</p>
        <form className="assign-form" onSubmit={submit}>
          <input className="input" name="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={300} aria-label="Title" required />
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" maxLength={5000} aria-label="Notes" />
          <div className="assign-grid">
            <label className="range-field"><span>Date</span><input className="input sm" type="date" value={due} onChange={(e) => { setDue(e.target.value); if (!e.target.value) setTime('') }} /></label>
            <label className="range-field"><span>Time</span><input className="input sm" type="time" value={time} disabled={!due} onChange={(e) => setTime(e.target.value)} title={due ? '' : 'Pick a date first'} /></label>
            <label className="range-field"><span>Priority</span>
              <Select className="input sm" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>{PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}</Select>
            </label>
            <label className="range-field"><span>Repeat</span>
              <Select className="input sm" value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>{REPEATS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}</Select>
            </label>
          </div>
          {repeat > 0 && !due && <p className="help">Repeats start today unless you pick a date.</p>}
          <textarea className="input" rows={2} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="Steps, one per line (optional)" aria-label="Steps" />
          <div className="assign-grid two">
            <input className="input sm" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="Link (optional)" aria-label="Link" aria-invalid={!urlOk} />
            <input className="input sm" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#tags (optional)" aria-label="Tags" />
          </div>

          <fieldset className="who">
            <legend>Who gets it</legend>
            <div className="seg sm" role="radiogroup" aria-label="Who gets it">
              <button type="button" role="radio" aria-checked={everyone} className={everyone ? 'on' : ''} onClick={() => setEveryone(true)}>Everyone</button>
              <button type="button" role="radio" aria-checked={!everyone} className={!everyone ? 'on' : ''} onClick={() => setEveryone(false)}>Choose people{!everyone && picked.length ? ` (${picked.length})` : ''}</button>
            </div>
            {everyone ? (
              <p className="help">Everyone except you ({plural(count, 'person', 'people')}).</p>
            ) : (
              <>
                {(people?.length || 0) > 6 && <input className="input sm" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find someone" aria-label="Find someone" />}
                <ul className="who-list">
                  {shown.map((p) => {
                    const on = picked.includes(p.username)
                    return (
                      <li key={p.username}>
                        <label className={`who-item${on ? ' on' : ''}`}>
                          <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== p.username) : [...picked, p.username])} />
                          <span className="chat-avatar">{(p.name || p.username).slice(0, 1).toUpperCase()}</span>
                          <span className="who-name"><b>{p.name}</b><small>@{p.username}</small></span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
                <div className="row">
                  <button type="button" className="linkish" onClick={() => setPicked((people || []).map((p) => p.username))}>Select all</button>
                  <button type="button" className="linkish" onClick={() => setPicked([])}>Clear</button>
                </div>
              </>
            )}
          </fieldset>

          {waOn && (
            <label className="toggle tight">
              <input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} />
              <span>Also send it on WhatsApp</span>
            </label>
          )}
          <div className="assign-actions">
            {!urlOk && <span className="help bad">The link should start with https://</span>}
            <span className="spacer" />
            <button className="btn" disabled={!can}>{busy ? 'Sending…' : `📌 Give to ${plural(count, 'person', 'people')}`}</button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Tasks you gave</h2>
        <p className="help">You only see these, nothing else of theirs.</p>
        {!assigned ? <p className="muted">Loading…</p> : assigned.length === 0 ? <p className="muted admin-empty">Nothing yet.</p> : (
          <ul className="assign-list">
            {assigned.map((a) => {
              const total = a.to.length
              const left = a.counts.todo + a.counts.doing
              const expanded = open === a.id
              return (
                <li key={a.id} className={`assign-item${expanded ? ' open' : ''}`}>
                  <button type="button" className="assign-head" onClick={() => setOpen(expanded ? null : a.id)} aria-expanded={expanded}>
                    <span className="assign-title">
                      <b>{a.title}</b>
                      <small>
                        {a.due ? `Due ${formatDay(a.due)}${a.time ? `, ${formatTime(a.time)}` : ''}` : 'No date'}
                        {a.repeat ? ` · ${describeRepeat(a.repeat)}` : ''}
                        {a.priority ? ` · ${PRIORITIES[a.priority]} priority` : ''}
                        {` · ${plural(total, 'person', 'people')} · ${ago(a.at)}`}
                      </small>
                    </span>
                    <span className="assign-num"><b>{a.counts.done}</b>/{total} done</span>
                  </button>
                  <ProgressStack counts={a.counts} total={total} />
                  <div className="assign-legend">
                    {(['done', 'doing', 'todo', 'removed'] as St[]).filter((s) => a.counts[s]).map((s) => (
                      <span key={s}><i className={`key seg-${s}`} />{a.counts[s]} {ST_LABEL[s].toLowerCase()}</span>
                    ))}
                  </div>
                  {expanded && (
                    <ul className="assign-people">
                      {a.people.map((p) => (
                        <li key={p.username}>
                          <span className={`status-dot st-${p.status === 'removed' ? 'todo' : p.status}${p.status === 'removed' ? ' gone' : ''}`} />
                          <span className="who-name"><b>{p.name}</b><small>@{p.username}</small></span>
                          <span className={`assign-st st-${p.status}`}>{ST_LABEL[p.status]}{p.status === 'done' && p.doneAt ? ` · ${ago(p.doneAt)}` : ''}{p.rounds > 1 ? ` · ${p.rounds}×` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="row wrap assign-tools">
                    <button className="btn ghost sm" disabled={!left} onClick={() => remind(a)} title={left ? 'Notify everyone who hasn’t finished it' : 'Everyone’s finished it'}>👋 Remind {left ? `the ${left} not done` : ''}</button>
                    <span className="spacer" />
                    <button className="btn quiet sm" onClick={() => setConfirm(a)}>Remove…</button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {confirm && (
        <ConfirmDialog
          title={`Remove “${confirm.title}”?`}
          confirmLabel="Take it back from everyone"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => remove(confirm, true)}
          secondary={{ label: 'Only remove it from this list', onClick: () => remove(confirm, false) }}
        >
          <b>Take it back</b> deletes every copy from everyone’s list, including completed and in-progress ones (and past rounds of repeating tasks).
          <br /><br />Or just remove it from this page and let people keep theirs.
        </ConfirmDialog>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- people
function PeopleTab({ people, onRefresh, onGive, onAnnounce }: { people: Person[] | null; onRefresh: () => void; onGive: (u: string) => void; onAnnounce: (u: string) => void }) {
  const [find, setFind] = useState('')
  const q = find.trim().toLowerCase()
  const shown = (people || []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.username.includes(q))
  const tour = async (p: Person) => {
    try { await api(`/admin/people/${encodeURIComponent(p.username)}/tour`, 'POST', {}); toast(`${p.name} will get the tutorial next time`); onRefresh() } catch (e: any) { toast(e.message) }
  }
  return (
    <section className="card">
      <div className="chart-head">
        <div>
          <h2>People &amp; usage</h2>
          <p className="help">Counts only. Their tasks stay private.</p>
        </div>
        <div className="row">
          {(people?.length || 0) > 6 && <input className="input sm" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find someone" aria-label="Find someone" />}
          <button className="btn ghost sm" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
      {!people ? <p className="muted">Loading…</p> : people.length === 0 ? <p className="muted">Nobody yet.</p> : (
        <div className="table-wrap">
          <table className="data-table people">
            <thead>
              <tr><th>Person</th><th>Open</th><th>Overdue</th><th>Done</th><th>Last active</th><th>Notifications</th><th>WhatsApp</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.username}>
                  <td><b>{p.name}{p.bot && <span className="badge bot-badge" title="WhatsApp Buddy writes from this account">🤖 Bot</span>}</b><small>@{p.username}{p.tz ? ` · ${p.tz}` : ''}</small></td>
                  <td>{p.open}</td>
                  <td>{p.overdue ? <span className="bad">{p.overdue}</span> : 0}</td>
                  <td>{p.done}</td>
                  <td>{ago(p.lastSeen)}</td>
                  <td>{p.devices ? <span className="badge ok">{plural(p.devices, 'device')}</span> : <span className="badge">Off</span>}</td>
                  <td>
                    {!p.whatsapp || p.whatsapp.exists === false ? <span className="badge">No WhatsApp</span>
                      : p.whatsapp.error ? <span className="badge warn" title={p.whatsapp.error}>Unknown</span>
                      : p.whatsapp.connected ? <span className="badge ok"><i className="dot" />{p.whatsapp.phone || 'Connected'}</span>
                      : <span className="badge warn">{p.whatsapp.status === 'idle' || p.whatsapp.status === 'qr' ? 'Not linked yet' : 'Not connected'}</span>}
                    {p.waReminders && <small>Reminders on WhatsApp</small>}
                  </td>
                  <td className="people-actions">
                    <button className="btn ghost sm" onClick={() => onGive(p.username)}>📌 Give a task</button>
                    <button className="btn quiet sm" onClick={() => onAnnounce(p.username)}>📣 Message</button>
                    <button className="btn quiet sm" onClick={() => tour(p)} disabled={!p.tourDone} title={p.tourDone ? 'Show them the tutorial next time they open the app' : 'They’ll get it next time they open the app'}>{p.tourDone ? '▶ Tutorial again' : 'Tutorial due'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------ announcements
function AnnounceTab({ people, settings, to, setTo, onChanged }: { people: Person[] | null; settings: Settings | null; to: string; setTo: (v: string) => void; onChanged: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const announce = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    try {
      const r = await api<{ pushed: number }>('/admin/announce', 'POST', { title, body, to })
      toast(`Sent to ${plural(r.pushed, 'device')}`)
      setTitle('')
      setBody('')
      onChanged()
    } catch (e: any) { toast(e.message) }
    setBusy(false)
  }
  const remove = async (id: string) => {
    try { await api(`/admin/announce/${id}`, 'DELETE'); onChanged() } catch (e: any) { toast(e.message) }
  }
  return (
    <div className="admin-cols">
      <section className="card">
        <h2>Send an announcement</h2>
        <p className="help">Sends a notification and shows a banner until they close it.</p>
        <form onSubmit={announce} className="announce-form">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={80} aria-label="Title" />
          <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message (optional)" maxLength={500} aria-label="Message" />
          <div className="row wrap">
            <label className="sort"><span>To</span>
              <Select className="input sm" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="all">Everyone</option>
                {people?.map((p) => <option key={p.username} value={p.username}>{p.name}</option>)}
              </Select>
            </label>
            <span className="spacer" />
            <button className="btn" disabled={busy || !title.trim()}>Send announcement</button>
          </div>
        </form>
      </section>
      <section className="card">
        <h2>Sent</h2>
        {!settings ? <p className="muted">Loading…</p> : !settings.announcements.length ? <p className="muted admin-empty">No announcements yet.</p> : (
          <ul className="announce-list">
            {settings.announcements.map((a) => (
              <li key={a.id}>
                <span><b>{a.title}</b>{a.body && <small>{a.body}</small>}<small>{a.to === 'all' ? 'Everyone' : `@${a.to}`} · {ago(a.at)}</small></span>
                <button className="icon-btn sm" aria-label={`Delete announcement ${a.title}`} title="Delete (removes the banner for everyone)" onClick={() => remove(a.id)}>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ----------------------------------------------------------------- whatsapp
const statusText = (a: { connected?: boolean; status?: string }) =>
  a.connected ? 'Online' : a.status === 'idle' || a.status === 'qr' ? 'Not linked yet' : a.status === 'logged-out' ? 'Logged out, scan the QR again' : 'Offline, reconnecting'

function WhatsAppTab({ settings, setSettings, onChanged }: { settings: Settings | null; setSettings: (s: Settings) => void; onChanged: () => void }) {
  const [test, setTest] = useState('')
  const [busy, setBusy] = useState(false)
  const [guide, setGuide] = useState(false)
  const setFeature = async (key: keyof Settings['whatsapp'], on: boolean) => {
    if (!settings) return
    setSettings({ ...settings, whatsapp: { ...settings.whatsapp, [key]: on } })
    try { await api('/admin/settings', 'POST', { whatsapp: { [key]: on } }) } catch (e: any) { toast(e.message); onChanged() }
  }
  const setBot = async (bot: string) => {
    if (bot && !confirm('Buddy will send everyone’s messages (task titles and notes) from this account, so they’ll show on its phone.\n\nOnly use a spare number set up for the bot, not someone’s personal WhatsApp.')) { onChanged(); return }
    setTest('')
    try {
      const r = await api<{ bot: Bot | null }>('/admin/settings', 'POST', { bot: bot || null })
      if (settings) setSettings({ ...settings, bot: r.bot })
      toast(bot ? 'Buddy now sends from this account' : 'No bot. Buddy uses everyone’s “Message yourself” chat')
    } catch (e: any) { toast(e.message); onChanged() }
  }
  const runTest = async () => {
    setBusy(true)
    setTest('Checking…')
    try {
      const r = await api<{ bot: Bot | null; sent?: boolean }>('/admin/test', 'POST', {})
      setTest(!r.bot ? 'No bot picked yet.' : r.sent ? `Online. It just messaged you from ${r.bot.phone}.` : `Online (${r.bot.phone}).`)
    } catch (e: any) {
      setTest(e.message)
    }
    setBusy(false)
  }
  const bot = settings?.bot
  const choices = (settings?.accounts || []).filter((a) => a.exists !== false)
  return (
    <>
      <section className="card admin-narrow">
        <h2>WhatsApp Buddy bot 🤖</h2>
        <p className="help">
          Pick an account linked to a <b>spare WhatsApp number</b> and Buddy messages everyone from it, so their phones buzz like a normal chat.
          Without one, Buddy writes in each person’s “Message yourself” chat, which doesn’t notify.
        </p>
        {!settings ? <p className="muted">Loading…</p> : (
          <>
            <div className="bot-pick">
              <label className="field">
                <span className="label">Bot account</span>
                <Select className="input" value={bot?.username || ''} disabled={settings.botFromEnv} onChange={(e) => setBot(e.target.value)} aria-label="Bot account">
                  <option value="">No bot (use “Message yourself”)</option>
                  {choices.map((a) => <option key={a.username} value={a.username}>{a.name} (@{a.username}){a.phone ? ` · ${a.phone}` : ''}</option>)}
                </Select>
                {settings.botFromEnv && <span className="help">Set by the <b>BOT_USER</b> variable in Railway.</span>}
              </label>
              {bot && (
                <span className={`badge ${bot.connected ? 'ok' : 'warn'}`}>{bot.connected && <i className="dot" />}{statusText(bot)}{bot.phone ? ` · ${bot.phone}` : ''}</span>
              )}
            </div>
            <div className="row wrap">
              <button className="btn ghost sm" onClick={runTest} disabled={busy || !bot}>Test the bot</button>
              {test && <span className="help test-result">{test}</span>}
            </div>
            <button type="button" className="linkish" onClick={() => setGuide(!guide)} aria-expanded={guide}>{guide ? 'Hide setup steps' : 'How to set up a bot number'}</button>
            {guide && (
              <ol className="bot-guide">
                <li>Get a spare number with WhatsApp: a prepaid SIM in an old phone, or WhatsApp Business with a second number. Not someone’s personal WhatsApp, since the bot reads everything sent to it.</li>
                <li>In Whats Up’s admin, add a person like <code>buddy</code> and open its setup link in a private window to set a password.</li>
                <li>Sign in as it and scan the QR code from the spare phone (WhatsApp → Linked devices). Keep that phone charged and online.</li>
                <li>Pick it above and hit <b>Test the bot</b>. Have everyone save the number as a contact so messages don’t end up in spam.</li>
              </ol>
            )}
          </>
        )}
      </section>
      <section className="card admin-narrow">
        <h2>WhatsApp features</h2>
        {!settings ? <p className="muted">Loading…</p> : (
          <ul className="feature-list">
            {FEATURES.map((f) => (
              <li key={f.key}>
                <span><b>{f.label}</b><small>{f.help}</small></span>
                <Switch on={settings.whatsapp[f.key]} label={f.label} onChange={(on) => setFeature(f.key, on)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
