import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './auth.js'
import { applyTask } from './store.js'

/**
 * Groups: a few Whats Up users sharing one task list (a project, a household, a
 * class). Everyone in a group sees and edits its tasks; a task can be given to one
 * member ("assignee") or left for anyone. Personal todolists stay private: a group
 * only ever holds the tasks put in it.
 *
 *   /data/todo/groups/<id>.json  →  { id, name, emoji, owner, members: [usernames], tasks: [...], rev, createdAt }
 */

const MAX_MEMBERS = 30
const MAX_GROUPS_PER_USER = 50
const MAX_TASKS = 1000
const id = () => crypto.randomBytes(8).toString('base64url')
const str = (v, max) => String(v ?? '').trim().slice(0, max)
const ID_RE = /^[A-Za-z0-9_-]{6,20}$/

export class Groups {
  /** `isUser(u)` says whether a username is a real account; `onChange(group, members)` lets members' pages refresh. */
  constructor(dataDir, { isUser, onChange = () => {} }) {
    this.dir = path.join(dataDir, 'groups')
    fs.mkdirSync(this.dir, { recursive: true })
    this.isUser = isUser
    this.onChange = onChange
    this.cache = new Map()
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try { const g = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); this.cache.set(g.id, g) } catch {}
    }
  }

  save(g, before = g.members) {
    g.rev = (g.rev || 0) + 1
    const file = path.join(this.dir, `${g.id}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(g), { mode: 0o600 })
    fs.renameSync(tmp, file)
    this.cache.set(g.id, g)
    // everyone in it now, and anyone who just left, hears about it
    this.onChange(g, [...new Set([...before, ...g.members])])
    return g
  }

  /** The groups someone is in. */
  mine(u) {
    return [...this.cache.values()].filter((g) => g.members.includes(u)).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** A group, if `u` is in it (otherwise it doesn't exist, as far as they're concerned). */
  get(u, gid) {
    const g = ID_RE.test(String(gid)) ? this.cache.get(gid) : null
    if (!g || !g.members.includes(u)) throw new HttpError(404, 'Group not found')
    return g
  }

  cleanMembers(list, keep) {
    const out = [...new Set([...(Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase()), ...keep])]
    for (const m of out) if (!this.isUser(m)) throw new HttpError(400, `No account called “${m}”`)
    if (out.length > MAX_MEMBERS) throw new HttpError(400, `A group can have up to ${MAX_MEMBERS} people`)
    return out
  }

  create(u, body) {
    if (this.mine(u).length >= MAX_GROUPS_PER_USER) throw new HttpError(400, 'You’re in too many groups. Leave one first.')
    const name = str(body.name, 60)
    if (!name) throw new HttpError(400, 'Give the group a name')
    const g = {
      id: id(), name, emoji: str(body.emoji, 8) || '👥', owner: u,
      members: this.cleanMembers(body.members, [u]), tasks: [], rev: 0, createdAt: Date.now(),
    }
    return this.save(g, [])
  }

  /** Rename, change the emoji, add people (anyone in it); remove people (only whoever made it). */
  update(u, gid, body) {
    const g = this.get(u, gid)
    const before = [...g.members]
    if ('name' in body) {
      const name = str(body.name, 60)
      if (!name) throw new HttpError(400, 'Give the group a name')
      g.name = name
    }
    if ('emoji' in body) g.emoji = str(body.emoji, 8) || '👥'
    if ('members' in body) {
      const next = this.cleanMembers(body.members, [g.owner])
      const removed = g.members.filter((m) => !next.includes(m) && m !== u)
      if (removed.length && u !== g.owner) throw new HttpError(403, 'Only the group’s owner can remove people')
      g.members = next.includes(u) || u === g.owner ? next : [...next, u]
      for (const t of g.tasks) if (t.assignee && !g.members.includes(t.assignee)) t.assignee = null
    }
    return this.save(g, before)
  }

  /** Leave a group. The last one out deletes it; if its maker leaves, the next person looks after it. */
  leave(u, gid) {
    const g = this.get(u, gid)
    const before = [...g.members]
    g.members = g.members.filter((m) => m !== u)
    for (const t of g.tasks) if (t.assignee === u) t.assignee = null
    if (!g.members.length) return this.remove(u, gid, before)
    if (g.owner === u) g.owner = g.members[0]
    return this.save(g, before)
  }

  /** Delete the whole group (whoever made it). */
  remove(u, gid, before = null) {
    const g = before ? this.cache.get(gid) : this.get(u, gid)
    if (!before && g.owner !== u) throw new HttpError(403, 'Only the group’s owner can delete it')
    fs.rmSync(path.join(this.dir, `${g.id}.json`), { force: true })
    this.cache.delete(g.id)
    this.onChange({ ...g, deleted: true }, before || g.members)
    return { ok: true }
  }

  // ------------------------------------------------------------ tasks
  apply(g, task, body) {
    const fields = { ...body }
    // no lists, repeats or personal reminders in a group: just the task itself
    for (const k of ['listId', 'repeat', 'remind', 'wa', 'chat']) delete fields[k]
    applyTask(task, fields, { lists: [] })
    if ('assignee' in body) {
      const a = body.assignee ? String(body.assignee) : null
      if (a && !g.members.includes(a)) throw new HttpError(400, 'Assign it to someone in the group')
      task.assignee = a
    }
    return task
  }

  addTask(u, gid, body) {
    const g = this.get(u, gid)
    if (g.tasks.length >= MAX_TASKS) throw new HttpError(400, 'This group is full. Clear some finished tasks first.')
    const now = Date.now()
    const task = this.apply(g, {
      id: id(), title: '', notes: '', listId: null, done: false, doneAt: null, status: 'todo', due: null, time: null,
      remind: null, repeat: null, priority: 0, tags: [], subtasks: [], links: [], assignee: null,
      by: u, doneBy: null, order: Math.min(0, ...g.tasks.map((t) => t.order)) - 1, createdAt: now, updatedAt: now,
    }, { title: body.title, ...body })
    g.tasks.push(task)
    this.save(g)
    return task
  }

  updateTask(u, gid, tid, body) {
    const g = this.get(u, gid)
    const task = g.tasks.find((t) => t.id === tid)
    if (!task) throw new HttpError(404, 'That task no longer exists')
    const wasDone = task.done
    const next = this.apply(g, { ...task }, body)
    if (next.done !== wasDone) next.doneBy = next.done ? u : null
    Object.assign(task, next)
    this.save(g)
    return task
  }

  deleteTask(u, gid, tid) {
    const g = this.get(u, gid)
    const i = g.tasks.findIndex((t) => t.id === tid)
    if (i < 0) throw new HttpError(404, 'That task no longer exists')
    const [task] = g.tasks.splice(i, 1)
    this.save(g)
    return task
  }

  clearDone(u, gid) {
    const g = this.get(u, gid)
    const n = g.tasks.filter((t) => t.done).length
    g.tasks = g.tasks.filter((t) => !t.done)
    this.save(g)
    return { removed: n }
  }

  /** Someone's account was removed: take them out of every group. */
  forget(u) {
    for (const g of this.mine(u)) { try { this.leave(u, g.id) } catch {} }
  }
}
