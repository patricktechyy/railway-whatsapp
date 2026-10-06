import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './auth.js'

/**
 * Exams: one shared timetable per school, kept by the admin.
 *
 * People pick their school (or the admin sets it) and, if they like, just the
 * subjects they take. Anyone can ask for an exam to be added; the admin adds,
 * edits or turns those requests down.
 *
 *   /data/todo/exams.json → { schools, exams, requests, people: { username: { school, subjects } } }
 */

const id = () => crypto.randomBytes(6).toString('base64url')
const str = (v, max) => String(v ?? '').trim().slice(0, max)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const COLORS = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet']

const validDate = (d) => DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))

export class Exams {
  /** `isUser(u)`: is that a real account. `onChange(kind, who)`: tell open pages ('all' or a list of usernames). */
  constructor(dataDir, { isUser, onChange = () => {} }) {
    this.file = path.join(dataDir, 'exams.json')
    this.isUser = isUser
    this.onChange = onChange
    this.d = { schools: [], exams: [], requests: [], people: {} }
    try { Object.assign(this.d, JSON.parse(fs.readFileSync(this.file, 'utf8'))) } catch {}
  }

  save(kind = 'exams') {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.onChange(kind)
  }

  // ---------------------------------------------------------- reading
  school(sid) { return this.d.schools.find((s) => s.id === sid) || null }
  mine(u) { return this.d.people[u] || { school: null, subjects: [] } }

  /** What someone sees: their school's exams, their requests. Admins can look at any school, or all. */
  view(u, { admin = false, school } = {}) {
    const me = this.mine(u)
    // admins look at any school they pick; with no school of their own, every school
    const sid = admin ? school || me.school || 'all' : me.school
    const exams = this.d.exams
      .filter((e) => (sid === 'all' ? true : e.school === sid))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''))
    const requests = this.d.requests
      .filter((r) => (admin ? r.status === 'pending' || r.by === u : r.by === u))
      .sort((a, b) => b.at - a.at)
      .slice(0, 100)
    return {
      schools: this.d.schools.map((s) => ({ ...s, people: Object.values(this.d.people).filter((p) => p.school === s.id).length })),
      school: me.school && this.school(me.school) ? me.school : null,
      subjects: me.subjects || [],
      showing: sid || null,
      exams,
      requests,
    }
  }

  /** Someone's exams (their school, their subjects if they picked some): for the calendar feed and the planner. */
  examsFor(u) {
    const me = this.mine(u)
    if (!me.school) return []
    const subs = (me.subjects || []).map((s) => s.toLowerCase())
    return this.d.exams.filter((e) => e.school === me.school && (!subs.length || subs.includes(e.subject.toLowerCase())))
  }

  // ---------------------------------------------------------- yours
  /** Your school and subjects. You pick your school once; after that only the admin changes it. */
  setMine(u, body, { byAdmin = false } = {}) {
    const cur = { ...this.mine(u) }
    if ('school' in body) {
      const sid = body.school ? String(body.school) : null
      if (sid && !this.school(sid)) throw new HttpError(404, 'That school isn’t on the list')
      if (!byAdmin && cur.school && this.school(cur.school) && sid !== cur.school) throw new HttpError(403, 'Ask your admin to change your school')
      cur.school = sid
    }
    if ('subjects' in body) {
      const list = Array.isArray(body.subjects) ? body.subjects : []
      cur.subjects = [...new Set(list.map((s) => str(s, 40)).filter(Boolean))].slice(0, 30)
    }
    this.d.people[u] = cur
    this.save('mine')
    return cur
  }

  request(u, body) {
    const ex = this.clean(body, { school: this.mine(u).school })
    if (this.d.requests.filter((r) => r.by === u && r.status === 'pending').length >= 20) throw new HttpError(400, 'You have 20 requests waiting already')
    const r = { ...ex, id: id(), by: u, status: 'pending', reason: '', at: Date.now(), examId: null }
    this.d.requests.unshift(r)
    this.d.requests = this.d.requests.slice(0, 500)
    this.save('requests')
    return r
  }

  withdraw(u, rid) {
    const r = this.d.requests.find((x) => x.id === rid && x.by === u)
    if (!r) throw new HttpError(404, 'That request is gone')
    if (r.status !== 'pending') throw new HttpError(409, 'The admin has already answered it')
    this.d.requests = this.d.requests.filter((x) => x !== r)
    this.save('requests')
    return { ok: true }
  }

  // ---------------------------------------------------------- admin
  clean(body, { school } = {}) {
    const subject = str(body.subject, 40)
    if (!subject) throw new HttpError(400, 'Which subject?')
    const date = str(body.date, 10)
    if (!validDate(date)) throw new HttpError(400, 'Pick a date')
    const start = body.start ? str(body.start, 5) : null
    if (start && !TIME_RE.test(start)) throw new HttpError(400, 'That start time doesn’t look right')
    const minutes = body.minutes == null || body.minutes === '' ? null : Math.round(Number(body.minutes))
    if (minutes !== null && (!Number.isFinite(minutes) || minutes < 5 || minutes > 600)) throw new HttpError(400, 'Length should be 5 minutes to 10 hours')
    const sid = body.school !== undefined ? (body.school ? String(body.school) : null) : school
    if (!sid || !this.school(sid)) throw new HttpError(400, 'Pick a school')
    return {
      school: sid,
      subject,
      paper: str(body.paper, 40),
      date,
      start,
      minutes,
      who: str(body.who, 30), // e.g. "Sec 4", when a school's levels sit different papers
      venue: str(body.venue, 60),
      notes: str(body.notes, 600),
    }
  }

  addExam(by, body) {
    if (this.d.exams.length >= 3000) throw new HttpError(400, 'That’s a lot of exams. Delete some old ones first.')
    const e = { ...this.clean(body), id: id(), by, at: Date.now() }
    this.d.exams.push(e)
    this.save()
    return e
  }

  updateExam(eid, body) {
    const e = this.d.exams.find((x) => x.id === eid)
    if (!e) throw new HttpError(404, 'That exam is gone')
    Object.assign(e, this.clean({ ...e, ...body }), { at: Date.now() })
    this.save()
    return e
  }

  deleteExam(eid) {
    const n = this.d.exams.length
    this.d.exams = this.d.exams.filter((x) => x.id !== eid)
    if (n === this.d.exams.length) throw new HttpError(404, 'That exam is gone')
    this.save()
    return { ok: true }
  }

  /** Add a requested exam (with any changes the admin made), or turn it down. */
  answer(by, rid, { approve, changes = {}, reason = '' }) {
    const r = this.d.requests.find((x) => x.id === rid)
    if (!r) throw new HttpError(404, 'That request is gone')
    if (r.status !== 'pending') throw new HttpError(409, 'Already answered')
    if (approve) {
      const e = this.addExam(by, { ...r, ...changes })
      r.status = 'added'
      r.examId = e.id
    } else {
      r.status = 'declined'
      r.reason = str(reason, 200)
    }
    r.answeredAt = Date.now()
    this.save('requests')
    return r
  }

  addSchool(body) {
    const name = str(body.name, 60)
    if (!name) throw new HttpError(400, 'Name the school')
    if (this.d.schools.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'That school is already on the list')
    const s = { id: id(), name, color: COLORS[this.d.schools.length % COLORS.length] }
    this.d.schools.push(s)
    this.save()
    return s
  }

  updateSchool(sid, body) {
    const s = this.school(sid)
    if (!s) throw new HttpError(404, 'That school is gone')
    if ('name' in body) {
      const name = str(body.name, 60)
      if (!name) throw new HttpError(400, 'Name the school')
      s.name = name
    }
    if ('color' in body && COLORS.includes(body.color)) s.color = body.color
    this.save()
    return s
  }

  /** Delete a school and its exams; its people go back to "no school". */
  deleteSchool(sid) {
    if (!this.school(sid)) throw new HttpError(404, 'That school is gone')
    this.d.schools = this.d.schools.filter((s) => s.id !== sid)
    this.d.exams = this.d.exams.filter((e) => e.school !== sid)
    for (const p of Object.values(this.d.people)) if (p.school === sid) p.school = null
    this.save()
    return { ok: true }
  }

  /** The admin puts someone in a school. */
  setSchoolOf(u, sid) {
    if (!this.isUser(u)) throw new HttpError(404, 'No such person')
    return this.setMine(u, { school: sid }, { byAdmin: true })
  }

  pending() { return this.d.requests.filter((r) => r.status === 'pending').length }

  forget(u) {
    if (this.d.people[u]) { delete this.d.people[u]; this.save('mine') }
  }
}
