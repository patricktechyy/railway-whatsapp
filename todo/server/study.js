import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './auth.js'

/**
 * The study planner: each person's own revision plan, day by day.
 *
 * Like a study timetable on a spreadsheet: every day has the tests happening that
 * day and what you'll study (a subject, how: RE = revise/memorise, P = practice,
 * and the topics, ticked off as you go). Days can be rest days or late days, and
 * subjects can be marked as priority. Exams come from the Exams page, so they're
 * not stored here.
 *
 *   /data/todo/study/<username>.json → { rev, subjects, tags, days, tests, blocks }
 *
 * The page saves the whole plan at once, with the rev it started from; if another
 * device saved in between, it gets a 409 and the newer plan.
 */

const str = (v, max) => String(v ?? '').trim().slice(0, max)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/
const MODES = ['', 'RE', 'P', 'RE+P']
const COLORS = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'none']
const KINDS = ['rest', 'late']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const empty = () => ({ rev: 0, subjects: [], tags: [], days: {}, tests: [], blocks: [] })
const newId = () => crypto.randomBytes(5).toString('base64url')
const okId = (x) => (ID_RE.test(String(x)) ? String(x) : newId())

export class StudyPlans {
  constructor(dataDir, { onChange = () => {} } = {}) {
    this.dir = path.join(dataDir, 'study')
    fs.mkdirSync(this.dir, { recursive: true })
    this.onChange = onChange
    this.cache = new Map()
  }

  file(u) { return path.join(this.dir, `${u}.json`) }

  get(u) {
    if (!this.cache.has(u)) {
      let d = empty()
      try { d = { ...d, ...JSON.parse(fs.readFileSync(this.file(u), 'utf8')) } } catch {}
      this.cache.set(u, d)
    }
    return this.cache.get(u)
  }

  /** Save the whole plan. `rev` is the version the page started from. */
  put(u, body) {
    const cur = this.get(u)
    if (Number(body.rev) !== cur.rev) throw Object.assign(new HttpError(409, 'Changed on another device'), { plan: cur })
    const next = { ...clean(body), rev: cur.rev + 1, updatedAt: Date.now() }
    const tmp = `${this.file(u)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
    fs.renameSync(tmp, this.file(u))
    this.cache.set(u, next)
    this.onChange(u, next.rev)
    return next
  }

  /** Change the plan from the server side (Buddy ticking a topic off); open pages reload it. */
  update(u, fn) {
    const cur = this.get(u)
    return this.put(u, { ...fn(JSON.parse(JSON.stringify(cur))), rev: cur.rev })
  }

  forget(u) {
    this.cache.delete(u)
    fs.rmSync(this.file(u), { force: true })
  }
}

function clean(body) {
  const subjects = (Array.isArray(body.subjects) ? body.subjects : []).slice(0, 40).map((s) => ({
    id: okId(s.id),
    name: str(s.name, 40) || 'Subject',
    color: COLORS.includes(s.color) ? s.color : 'none',
    priority: !!s.priority,
  }))
  const subjectIds = new Set(subjects.map((s) => s.id))
  // your own labels for study blocks (past papers, flashcards, teacher's list…)
  const tags = (Array.isArray(body.tags) ? body.tags : []).slice(0, 30).map((t) => ({
    id: okId(t.id),
    name: str(t.name, 24) || 'Tag',
    color: COLORS.includes(t.color) ? t.color : 'none',
  }))
  const tagIds = new Set(tags.map((t) => t.id))

  const days = {}
  for (const [k, v] of Object.entries(body.days && typeof body.days === 'object' ? body.days : {}).slice(0, 3000)) {
    if (DATE_RE.test(k) && KINDS.includes(v)) days[k] = v
  }

  const tests = (Array.isArray(body.tests) ? body.tests : []).slice(0, 1500).flatMap((t) => {
    const date = str(t.date, 10)
    const title = str(t.title, 80)
    if (!DATE_RE.test(date) || !title) return []
    return [{ id: okId(t.id), date, title, note: str(t.note, 200) }]
  })

  const blocks = (Array.isArray(body.blocks) ? body.blocks : []).slice(0, 4000).flatMap((b, i) => {
    const date = str(b.date, 10)
    if (!DATE_RE.test(date)) return []
    const subject = subjectIds.has(b.subject) ? b.subject : null
    if (!subject) throw new HttpError(400, 'A study block needs a subject')
    return [{
      id: okId(b.id),
      date,
      subject,
      mode: MODES.includes(b.mode) ? b.mode : '',
      topics: (Array.isArray(b.topics) ? b.topics : []).slice(0, 40).flatMap((t) => {
        const text = str(t.text, 120)
        return text ? [{ id: okId(t.id), text, done: !!t.done }] : []
      }),
      note: str(b.note, 300),
      tags: [...new Set((Array.isArray(b.tags) ? b.tags : []).filter((t) => tagIds.has(t)))].slice(0, 8),
      time: TIME_RE.test(b.time) ? b.time : null, // when you'll start (for the reminder)
      minutes: Number.isFinite(Number(b.minutes)) && b.minutes >= 5 && b.minutes <= 600 ? Math.round(b.minutes) : null, // how long you planned
      spent: Math.max(0, Math.min(6000, Math.round(Number(b.spent) || 0))), // minutes on the focus timer
      done: !!b.done,
      order: Number.isFinite(Number(b.order)) ? Number(b.order) : i,
    }]
  })
  return { subjects, tags, days, tests, blocks }
}
