import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { HttpError } from './auth.js'
import { cleanRepeat, nextOccurrence } from './repeat.js'
import { cleanUrl } from './quickadd.js'
import { validTz } from './tz.js'
import { COUNTRIES } from './holidays.js'

/**
 * One JSON file per person on the /data volume:
 *   /data/users/<username>.json  →  { rev, profile, lists, tasks }
 * Every change bumps `rev` and is announced to that person's open tabs, so
 * phone and laptop stay in step.
 */

const MAX_TASKS = 5000
const MAX_LISTS = 100
// fixed categorical order, checked for colour-blind separation in light and dark
const COLORS = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet']
const listColor = (c, fallback) => (COLORS.includes(c) || HEX.test(c || '') ? (COLORS.includes(c) ? c : c.toLowerCase()) : fallback)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STATUSES = ['todo', 'doing', 'done']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const id = () => crypto.randomBytes(8).toString('base64url')
const str = (v, max) => String(v ?? '').trim().slice(0, max)

function defaults() {
  const now = Date.now()
  return {
    rev: 1,
    profile: { name: '', waReminders: true },
    lists: [
      { id: id(), name: 'Personal', emoji: '🌱', color: 'blue', order: 0, createdAt: now },
      { id: id(), name: 'School', emoji: '📚', color: 'orange', order: 1, createdAt: now },
      { id: id(), name: 'Home', emoji: '🏠', color: 'aqua', order: 2, createdAt: now },
    ],
    tasks: [],
  }
}

// ------------------------------------------------------------- validation
function cleanSubtasks(v) {
  if (!Array.isArray(v)) return []
  return v.slice(0, 50).map((s) => ({ id: str(s?.id, 20) || id(), title: str(s?.title, 200), done: !!s?.done })).filter((s) => s.title)
}

const HEX = /^#[0-9a-f]{6}$/i
const APPEARANCE_KEYS = ['sidebar', 'accent', 'button', 'taskBg']
const PRESETS = ['discord', 'mono', 'classic', 'custom']
const CUSTOM_KEYS = ['sidebar', 'accent', 'button', 'taskBg', 'page', 'card', 'text']

/** { preset, sidebar, accent, button, taskBg }: colours are #rrggbb or null (= the preset's own). */
function cleanAppearance(v) {
  if (!v || typeof v !== 'object') return null
  const out = { preset: PRESETS.includes(v.preset) ? v.preset : 'discord' }
  for (const k of APPEARANCE_KEYS) {
    if (v[k] === null || v[k] === undefined || v[k] === '') out[k] = null
    else if (HEX.test(v[k])) out[k] = v[k].toLowerCase()
    else throw new HttpError(400, `${k} must be a colour like #2563eb`)
  }
  // your saved Custom look: kept even while another style is chosen
  if (v.custom && typeof v.custom === 'object') {
    const c = { base: ['discord', 'mono', 'classic'].includes(v.custom.base) ? v.custom.base : 'discord' }
    for (const k of CUSTOM_KEYS) {
      const x = v.custom[k]
      if (x === null || x === undefined || x === '') c[k] = null
      else if (HEX.test(x)) c[k] = x.toLowerCase()
      else throw new HttpError(400, `${k} must be a colour like #2563eb`)
    }
    out.custom = c
  } else out.custom = null
  // the Personalize It gradient (any style)
  const pz = v.personalize
  if (pz && typeof pz === 'object') {
    if (!HEX.test(pz.from || '') || !HEX.test(pz.to || '')) throw new HttpError(400, 'The gradient needs two colours like #ff5500')
    const angle = Math.round(Number(pz.angle))
    out.personalize = { from: pz.from.toLowerCase(), to: pz.to.toLowerCase(), angle: Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : 135 }
  } else out.personalize = null
  return out
}

// ------------------------------------------------------ "Personalize It" board
export const WIDGETS = ['priority', 'todo', 'today', 'upcoming', 'doing', 'overdue', 'list', 'status', 'stats', 'notes']
const SIZES = ['sm', 'md', 'lg']
const STICKY = ['yellow', 'pink', 'green', 'blue', 'purple']
export function defaultBoard() {
  return {
    widgets: [
      { id: id(), type: 'priority', title: '', size: 'lg', config: {} },
      { id: id(), type: 'todo', title: '', size: 'md', config: {} },
      { id: id(), type: 'stats', title: '', size: 'sm', config: {} },
      { id: id(), type: 'today', title: '', size: 'md', config: {} },
      { id: id(), type: 'doing', title: '', size: 'sm', config: {} },
      { id: id(), type: 'notes', title: '', size: 'sm', config: { text: '' } },
    ],
  }
}
function cleanBoard(v, doc) {
  if (!v || !Array.isArray(v.widgets)) throw new HttpError(400, 'A board needs widgets')
  if (v.widgets.length > 20) throw new HttpError(400, 'A board can have at most 20 blocks')
  const seen = new Set()
  const widgets = v.widgets.map((w) => {
    if (!WIDGETS.includes(w?.type)) throw new HttpError(400, 'Unknown block type')
    let wid = str(w.id, 20)
    if (!/^[A-Za-z0-9_-]+$/.test(wid) || seen.has(wid)) wid = id()
    seen.add(wid)
    const config = {}
    if (w.type === 'notes') {
      config.text = str(w.config?.text, 2000)
      config.color = STICKY.includes(w.config?.color) ? w.config.color : 'yellow'
    }
    if (w.type === 'list') config.listId = doc.lists.some((l) => l.id === w.config?.listId) ? w.config.listId : null
    const h = Number(w.h)
    // width on a 12-column grid (3–12); older boards only had sm / md / lg
    const size = SIZES.includes(w.size) ? w.size : 'md'
    let cols = Number(w.w)
    if (!Number.isInteger(cols) || cols < 3 || cols > 12) cols = { sm: 4, md: 8, lg: 12 }[size]
    return {
      id: wid, type: w.type, title: str(w.title, 40), config,
      w: cols, size: cols <= 5 ? 'sm' : cols <= 9 ? 'md' : 'lg',
      h: Number.isInteger(h) && h >= 140 && h <= 1200 ? h : null, // your own height (px); null = fit the content
      hidden: !!w.hidden, // unticked in "Blocks": kept, just not shown
    }
  })
  return { widgets }
}

function cleanLinks(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const l of v.slice(0, 40)) {
    const url = cleanUrl(typeof l === 'string' ? l : l?.url)
    if (!url) throw new HttpError(400, 'Links must start with http:// or https://')
    if (!out.some((x) => x.url === url)) out.push({ url, title: str(l?.title, 80) })
  }
  return out.slice(0, 20)
}

/**
 * A WhatsApp reminder for one task ("💬 WhatsApp me"): either an exact moment
 * ({ at: ms }) or relative to the due date and time ({ before: minutes }).
 * `sent` is set by the server only, so editing it re-arms the reminder.
 */
function cleanWa(v) {
  if (!v || typeof v !== 'object') return null
  if (v.before !== undefined && v.before !== null) {
    const n = Number(v.before)
    if (!(Number.isInteger(n) && n >= 0 && n <= 7 * 24 * 60)) throw new HttpError(400, 'Invalid WhatsApp reminder')
    return { before: n }
  }
  const at = Number(v.at)
  const now = Date.now()
  if (!Number.isFinite(at) || at < now - 2 * 864e5 || at > now + 400 * 864e5) throw new HttpError(400, 'Pick a WhatsApp reminder time within the next year')
  return { at: Math.round(at) }
}

/** The WhatsApp chat a task came from ("Add to todolist" on a message): which chat, and its name then. */
const JID_RE = /^[0-9a-z.:_-]{3,80}@(s\.whatsapp\.net|g\.us|lid)$/i
function cleanChat(v) {
  if (!v) return null
  const jid = String(v.jid || '')
  if (!JID_RE.test(jid)) throw new HttpError(400, 'Invalid chat')
  return { jid, name: str(v.name, 60) || 'WhatsApp chat' }
}

const BUDDY_STYLES = ['friendly', 'short'] // Long / Short
/** WhatsApp Buddy settings: on/off, personality, and the morning / evening messages ('HH:MM' or null). */
function cleanBuddy(v) {
  const t = (x) => (typeof x === 'string' && TIME_RE.test(x) ? x : null)
  return { on: !!v?.on, style: BUDDY_STYLES.includes(v?.style) ? v.style : 'friendly', morning: t(v?.morning), evening: t(v?.evening) }
}

function cleanTags(v) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((t) => str(t, 24).replace(/^#/, '').toLowerCase()).filter(Boolean))].slice(0, 10)
}

/** Apply the fields present in `body` to `task`, validating each. (Group tasks use it too, with no lists.) */
export function applyTask(task, body, doc) {
  if ('title' in body) {
    const t = str(body.title, 300)
    if (!t) throw new HttpError(400, 'A task needs a title')
    task.title = t
  }
  if ('notes' in body) task.notes = str(body.notes, 5000)
  if ('listId' in body) {
    const l = body.listId ? String(body.listId) : null
    if (l && !doc.lists.some((x) => x.id === l)) throw new HttpError(400, 'That list no longer exists')
    task.listId = l
  }
  if ('due' in body) {
    if (body.due && !DATE_RE.test(body.due)) throw new HttpError(400, 'Due date must look like 2026-09-25')
    task.due = body.due || null
    if (!task.due) { task.time = null; task.remind = null; task.repeat = null }
  }
  if ('time' in body) {
    if (body.time && !TIME_RE.test(body.time)) throw new HttpError(400, 'Time must look like 14:30')
    task.time = task.due && body.time ? body.time : null
  }
  if ('remind' in body) {
    const n = body.remind === null || body.remind === '' ? null : Number(body.remind)
    if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 7 * 24 * 60)) throw new HttpError(400, 'Invalid reminder')
    task.remind = task.due ? n : null
  }
  if ('repeat' in body) {
    try { task.repeat = cleanRepeat(body.repeat) } catch (msg) { throw new HttpError(400, String(msg)) }
    // a repeat needs a starting day: default to today
    if (task.repeat && !task.due) {
      const d = new Date()
      task.due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
  }
  if ('priority' in body) {
    const p = Number(body.priority)
    task.priority = [0, 1, 2, 3].includes(p) ? p : 0
  }
  if ('tags' in body) task.tags = cleanTags(body.tags)
  if ('links' in body) task.links = cleanLinks(body.links)
  if ('subtasks' in body) task.subtasks = cleanSubtasks(body.subtasks)
  if ('wa' in body) task.wa = cleanWa(body.wa)
  if ('chat' in body) task.chat = cleanChat(body.chat)
  // status (not started / in progress / completed) and `done` always agree
  if ('status' in body || 'done' in body) {
    let status = STATUSES.includes(body.status) ? body.status : null
    if (!status) status = body.done ? 'done' : task.status === 'done' || task.done ? 'todo' : task.status || 'todo'
    const done = status === 'done'
    if (done !== task.done) task.doneAt = done ? Date.now() : null
    task.done = done
    task.status = status
  }
  if (!task.status) task.status = task.done ? 'done' : 'todo'
  task.updatedAt = Date.now()
  return task
}

// ------------------------------------------------------------------ store
export class Store {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'users')
    fs.mkdirSync(this.dir, { recursive: true })
    this.docs = new Map()
    this.bus = new EventEmitter()
    this.bus.setMaxListeners(0)
  }

  file(username) {
    return path.join(this.dir, `${username}.json`)
  }

  load(username) {
    let doc = this.docs.get(username)
    if (doc) return doc
    try {
      doc = JSON.parse(fs.readFileSync(this.file(username), 'utf8'))
    } catch {
      doc = defaults()
    }
    // tasks from before statuses existed
    for (const t of doc.tasks) {
      if (!t.status) t.status = t.done ? 'done' : 'todo'
      if (!t.links) t.links = []
    }
    if (doc.profile.waReminders === undefined) doc.profile.waReminders = true
    if (!doc.board) doc.board = defaultBoard()
    this.docs.set(username, doc)
    return doc
  }

  save(username, doc, { quiet = false } = {}) {
    if (!quiet) doc.rev++
    const file = this.file(username)
    const tmp = `${file}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(doc))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    if (!quiet) this.bus.emit(username, { type: 'changed', rev: doc.rev })
  }

  /** Run `fn` against the person's document, then save and broadcast. */
  change(username, fn) {
    const doc = this.load(username)
    const out = fn(doc)
    this.save(username, doc)
    return out
  }

  snapshot(username) {
    return this.load(username)
  }

  /** Every person with saved tasks (for the reminder scheduler). */
  usernames() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    } catch {
      return []
    }
  }

  // ------------------------------------------------------------- profile
  setProfile(username, body) {
    const cur = this.load(username).profile
    // the browser reports its timezone on every visit: only save a real change
    if (Object.keys(body).every((k) => k === 'tz') && (!validTz(body.tz) || body.tz === cur.tz)) return cur
    const out = this.change(username, (doc) => {
      if ('name' in body) doc.profile.name = str(body.name, 60)
      if ('waReminders' in body) doc.profile.waReminders = !!body.waReminders
      if ('tz' in body && validTz(body.tz)) doc.profile.tz = body.tz
      if ('holidayCountry' in body) {
        const c = body.holidayCountry
        if (c !== 'off' && !COUNTRIES[c]) throw new HttpError(400, 'Unknown country')
        doc.profile.holidayCountry = c
      }
      if ('appearance' in body) doc.profile.appearance = cleanAppearance(body.appearance)
      if ('tourDone' in body) doc.profile.tourDone = !!body.tourDone
      if ('buddy' in body) doc.profile.buddy = cleanBuddy(body.buddy)
      return doc.profile
    })
    // other devices pick up the new name, colours and holidays straight away
    this.bus.emit(username, { type: 'profile' })
    return out
  }

  /** Remember when someone last used the site (saved at most every 5 minutes). */
  touch(username) {
    const doc = this.load(username)
    const now = Date.now()
    if (now - (doc.profile.lastSeen || 0) < 5 * 60e3) return
    doc.profile.lastSeen = now
    this.save(username, doc, { quiet: true })
  }

  // --------------------------------------------------------------- tasks
  /**
   * `extra` is for the server only (never read from a request): e.g. `from`, set on a
   * task the admin gave someone. applyTask ignores unknown fields, so nobody can fake it.
   */
  addTask(username, body, extra = null) {
    return this.change(username, (doc) => {
      if (doc.tasks.length >= MAX_TASKS) throw new HttpError(400, `You can have at most ${MAX_TASKS} tasks. Clear some completed ones first.`)
      const now = Date.now()
      const task = {
        id: id(), title: '', notes: '', listId: null, done: false, doneAt: null,
        status: 'todo', due: null, time: null, remind: null, repeat: null, priority: 0, tags: [], subtasks: [], links: [],
        order: Math.min(0, ...doc.tasks.map((t) => t.order)) - 1, // new tasks go on top
        createdAt: now, updatedAt: now,
      }
      applyTask(task, { title: body.title, ...body }, doc)
      if (extra) Object.assign(task, extra)
      doc.tasks.push(task)
      return task
    })
  }

  /** The server noting that a task's WhatsApp reminder went out (`sig` says which version of it). */
  setWaSent(username, taskId, sig) {
    return this.change(username, (doc) => {
      const t = doc.tasks.find((x) => x.id === taskId)
      if (t?.wa) t.wa = { ...t.wa, sent: sig }
      return t
    })
  }

  /** Check a task's fields without saving anything (throws the same 400s addTask would). */
  checkTask(body) {
    const doc = { lists: [], tasks: [] }
    const task = { title: '', notes: '', listId: null, done: false, doneAt: null, status: 'todo', due: null, time: null, remind: null, repeat: null, priority: 0, tags: [], subtasks: [], links: [] }
    return applyTask(task, { title: body.title, ...body, listId: null }, doc)
  }

  /** Every task that came from one assignment (a repeating one has a copy per round). */
  tasksFrom(username, assignmentId) {
    return this.load(username).tasks.filter((t) => t.from?.assignment === assignmentId)
  }

  /** Remove every task copy belonging to an assignment, including completed and repeated copies. */
  withdrawAssignment(username, assignmentId) {
    const found = this.tasksFrom(username, assignmentId)
    if (!found.length) return 0
    this.change(username, (doc) => { doc.tasks = doc.tasks.filter((t) => t.from?.assignment !== assignmentId) })
    return found.length
  }

  updateTask(username, taskId, body) {
    return this.change(username, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId)
      if (!task) throw new HttpError(404, 'That task no longer exists')
      const wasDone = task.done
      // validate on a copy so a bad field never leaves a half-applied edit
      Object.assign(task, applyTask({ ...task }, body, doc))
      if (!wasDone && task.done && task.repeat) this.rollForward(doc, task)
      else if (wasDone && !task.done && task.spawnedId) this.undoRollForward(doc, task)
      return task
    })
  }

  /**
   * Finishing a repeating task keeps it as a completed record (so it counts
   * in Stats) and creates a fresh copy on the next date.
   */
  rollForward(doc, task) {
    const next = nextOccurrence(task.due, task.repeat)
    const repeat = task.repeat
    task.repeat = null
    if (!next) return // the series has ended
    const now = Date.now()
    const copy = {
      ...task,
      id: id(), done: false, status: 'todo', doneAt: null, due: next, repeat,
      subtasks: task.subtasks.map((s) => ({ ...s, id: id(), done: false })),
      createdAt: now, updatedAt: now,
    }
    delete copy.spawnedId
    task.spawnedId = copy.id
    doc.tasks.push(copy)
  }

  /** Un-ticking a finished repeat (Undo) removes the copy it made and restores the repeat. */
  undoRollForward(doc, task) {
    const i = doc.tasks.findIndex((t) => t.id === task.spawnedId)
    delete task.spawnedId
    if (i < 0 || doc.tasks[i].done) return
    task.repeat = doc.tasks[i].repeat
    task.order = doc.tasks[i].order
    doc.tasks.splice(i, 1)
  }

  deleteTask(username, taskId) {
    return this.change(username, (doc) => {
      const i = doc.tasks.findIndex((t) => t.id === taskId)
      if (i < 0) throw new HttpError(404, 'That task no longer exists')
      return doc.tasks.splice(i, 1)[0]
    })
  }

  /** `ids` is the new order of some tasks; they take the order slots they already held. */
  reorderTasks(username, ids) {
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids required')
    return this.change(username, (doc) => {
      const byId = new Map(doc.tasks.map((t) => [t.id, t]))
      const moving = ids.map((x) => byId.get(String(x))).filter(Boolean)
      const slots = moving.map((t) => t.order).sort((a, b) => a - b)
      moving.forEach((t, i) => { t.order = slots[i] })
      return { ok: true }
    })
  }

  clearCompleted(username, listId) {
    return this.change(username, (doc) => {
      const before = doc.tasks.length
      doc.tasks = doc.tasks.filter((t) => !t.done || (listId && t.listId !== listId))
      return { removed: before - doc.tasks.length }
    })
  }

  /** Cancel every WhatsApp reminder currently attached to this person's tasks. */
  clearWaReminders(username) {
    const doc = this.load(username)
    const count = doc.tasks.filter((t) => !!t.wa).length
    if (!count) return 0
    this.change(username, (next) => {
      for (const t of next.tasks) if (t.wa) t.wa = null
    })
    return count
  }

  // ------------------------------------------------------------ day notes
  /** Your own note on a calendar day: a short label shown by the date, details, and a colour. */
  setDayNote(username, date, body) {
    if (!DATE_RE.test(date)) throw new HttpError(400, 'Bad date')
    const label = str(body.label, 40)
    const notes = str(body.notes, 1000)
    const color = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet'].includes(body.color) ? body.color : 'blue'
    return this.change(username, (doc) => {
      doc.dayNotes ||= {}
      if (!label && !notes) { delete doc.dayNotes[date]; return null }
      if (Object.keys(doc.dayNotes).length >= 3000 && !doc.dayNotes[date]) throw new HttpError(400, 'Too many day notes')
      doc.dayNotes[date] = { label, notes, color, updatedAt: Date.now() }
      return doc.dayNotes[date]
    })
  }

  deleteDayNote(username, date) {
    return this.change(username, (doc) => {
      if (doc.dayNotes) delete doc.dayNotes[date]
      return { ok: true }
    })
  }

  // --------------------------------------------------------------- lists
  addList(username, body) {
    return this.change(username, (doc) => {
      if (doc.lists.length >= MAX_LISTS) throw new HttpError(400, `You can have at most ${MAX_LISTS} lists`)
      const name = str(body.name, 40)
      if (!name) throw new HttpError(400, 'A list needs a name')
      const list = {
        id: id(), name,
        emoji: str(body.emoji, 8) || '📝',
        color: listColor(body.color, COLORS[doc.lists.length % COLORS.length]),
        order: Math.max(-1, ...doc.lists.map((l) => l.order)) + 1,
        createdAt: Date.now(),
      }
      doc.lists.push(list)
      return list
    })
  }

  updateList(username, listId, body) {
    return this.change(username, (doc) => {
      const list = doc.lists.find((l) => l.id === listId)
      if (!list) throw new HttpError(404, 'That list no longer exists')
      if ('name' in body && !str(body.name, 40)) throw new HttpError(400, 'A list needs a name')
      if ('name' in body) {
        const name = str(body.name, 40)
        if (!name) throw new HttpError(400, 'A list needs a name')
        list.name = name
      }
      if ('emoji' in body) list.emoji = str(body.emoji, 8) || '📝'
      if ('color' in body) {
        if (!listColor(body.color, null)) throw new HttpError(400, 'Colour must be a list colour or like #ff5500')
        list.color = listColor(body.color, list.color)
      }
      return list
    })
  }

  /**
   * Deleting a list either keeps its tasks (they move to "No list") or deletes
   * them too. Returns everything needed to put it back (Undo).
   */
  deleteList(username, listId, { deleteTasks = false } = {}) {
    return this.change(username, (doc) => {
      const i = doc.lists.findIndex((l) => l.id === listId)
      if (i < 0) throw new HttpError(404, 'That list no longer exists')
      const inList = doc.tasks.filter((t) => t.listId === listId)
      if (deleteTasks) doc.tasks = doc.tasks.filter((t) => t.listId !== listId)
      else for (const t of inList) t.listId = null
      const list = doc.lists.splice(i, 1)[0]
      return { list, tasks: deleteTasks ? inList : [], moved: deleteTasks ? [] : inList.map((t) => t.id) }
    })
  }

  /** Undo for deleteList: the list comes back with the same id, and so do its tasks. */
  restoreList(username, body) {
    const src = body?.list || {}
    return this.change(username, (doc) => {
      if (doc.lists.length >= MAX_LISTS) throw new HttpError(400, `You can have at most ${MAX_LISTS} lists`)
      const name = str(src.name, 40)
      if (!name) throw new HttpError(400, 'A list needs a name')
      let lid = str(src.id, 20)
      if (!/^[A-Za-z0-9_-]+$/.test(lid) || doc.lists.some((l) => l.id === lid)) lid = id()
      const list = {
        id: lid, name, emoji: str(src.emoji, 8) || '📝',
        color: listColor(src.color, 'blue'),
        order: Number.isFinite(src.order) ? src.order : Math.max(-1, ...doc.lists.map((l) => l.order)) + 1,
        createdAt: Number.isFinite(src.createdAt) ? src.createdAt : Date.now(),
      }
      doc.lists.push(list)
      const moved = new Set(Array.isArray(body.moved) ? body.moved.map(String) : [])
      for (const t of doc.tasks) if (moved.has(t.id) && !t.listId) t.listId = lid
      const now = Date.now()
      for (const old of (Array.isArray(body.tasks) ? body.tasks : []).slice(0, MAX_TASKS)) {
        if (doc.tasks.length >= MAX_TASKS) break
        const tid = /^[A-Za-z0-9_-]{1,20}$/.test(String(old?.id)) && !doc.tasks.some((t) => t.id === old.id) ? old.id : id()
        const task = {
          id: tid, title: '', notes: '', listId: null, done: false, doneAt: null,
          status: 'todo', due: null, time: null, remind: null, repeat: null, priority: 0, tags: [], subtasks: [], links: [],
          order: Number.isFinite(old?.order) ? old.order : 0,
          createdAt: Number.isFinite(old?.createdAt) ? old.createdAt : now, updatedAt: now,
        }
        try {
          const { id: _i, order: _o, createdAt: _c, updatedAt: _u, doneAt: _d, spawnedId: _s, listId: _l, ...input } = old
          applyTask(task, { title: old.title, ...input, listId: lid }, doc)
        } catch { continue }
        if (task.done && Number.isFinite(old.doneAt)) task.doneAt = old.doneAt
        doc.tasks.push(task)
      }
      return list
    })
  }

  saveBoard(username, body) {
    return this.change(username, (doc) => {
      doc.board = cleanBoard(body, doc)
      return doc.board
    })
  }

  reorderLists(username, ids) {
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids required')
    return this.change(username, (doc) => {
      ids.forEach((x, i) => {
        const l = doc.lists.find((l) => l.id === String(x))
        if (l) l.order = i
      })
      return { ok: true }
    })
  }
}
