import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX = 200

/**
 * Tasks the admin gives people ("assignments"). The tasks themselves live in each
 * person's own file (with `from: { by, name, assignment }`), so they behave like any
 * other task. This file only remembers what was sent, to whom, and which task each
 * person got, so the admin can follow progress without seeing anyone's other tasks.
 *
 *   /data/assignments.json  →  [{ id, title, notes, due, time, priority, repeat, at, by, byName, to: [usernames] }]
 */
export class Assignments {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'assignments.json')
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.items = [] }
    if (!Array.isArray(this.items)) this.items = []
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.items))
    fs.renameSync(tmp, this.file)
  }

  newId() { return crypto.randomBytes(6).toString('base64url') }
  all() { return this.items }
  get(id) { return this.items.find((a) => a.id === id) || null }

  add(rec) {
    this.items = [rec, ...this.items].slice(0, MAX)
    this.save()
    return rec
  }

  remove(id) {
    const before = this.items.length
    this.items = this.items.filter((a) => a.id !== id)
    if (this.items.length !== before) this.save()
    return before !== this.items.length
  }
}

/**
 * Where each person is with an assignment: the status of their newest copy
 * (a repeating one makes a new copy each time it's done), or "removed" if they
 * deleted it.
 */
export function progressOf(tasks) {
  if (!tasks.length) return { status: 'removed', doneAt: null, rounds: 0 }
  const open = tasks.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt)[0]
  const t = open || tasks.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0]
  return { status: t.status || (t.done ? 'done' : 'todo'), doneAt: t.doneAt || null, rounds: tasks.filter((x) => x.done).length, taskId: t.id }
}
