import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError } from './auth.js'
import { Store } from './store.js'
import { Push } from './push.js'
import { Reminders } from './reminders.js'
import { LocalLink } from './local.js'
import { handleInbox, taskMessage, stripTodo, isTodoCommand } from './whatsapp.js'
import { Buddy, BUDDY_DEFAULTS, plain } from './buddy.js'
import { todayIn } from './tz.js'
import { Holidays, COUNTRIES, countryForTz } from './holidays.js'
import { Assignments, progressOf } from './assign.js'
import { Groups } from './groups.js'
import { CalendarFeeds } from './calendar.js'
import { parseQuickAdd } from './quickadd.js'
import { Exams } from './exams.js'
import { StudyPlans } from './study.js'

/**
 * Gavin's Todolist, as a part of Whats Up.
 *
 * Everything lives under /todo/ on the Whats Up server: the page (/todo/) and its
 * API (/todo/api/…). There is no separate sign-in: the Whats Up cookie says who you
 * are, and you only ever see your own tasks. Whats Up admins (the ADMIN_PASSWORD
 * login, or anyone marked as an admin) also get the Todolist's admin page.
 *
 * WhatsApp goes straight through the sessions running in this process (local.js):
 * reminders, "send this task to a chat", and WhatsApp Buddy, which writes from a bot
 * account the admin picks so it arrives on everyone's real WhatsApp.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, '..', 'dist')
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/
const ENV_ADMIN = 'admin' // the ADMIN_PASSWORD login's own todolist

export function createTodo({ dataDir, auth, sessions, whoami, version = '?', brand = process.env.TODO_BRAND || "Gavin's Todolist", tickMs = Number(process.env.REMINDER_TICK_MS) || 30000 }) {
  fs.mkdirSync(dataDir, { recursive: true })
  const store = new Store(dataDir)
  const push = new Push(dataDir)
  const link = new LocalLink(dataDir, sessions)
  const holidays = new Holidays(dataDir)
  const assignments = new Assignments(dataDir)
  const calendars = new CalendarFeeds(dataDir)
  // groups: shared task lists between Whats Up accounts; members' open pages refresh when one changes
  const groups = new Groups(dataDir, {
    isUser: (u) => !!auth.get(u) || u === ENV_ADMIN,
    onChange: (g, members) => { for (const m of members) store.bus.emit(m, { type: 'group', id: g.id }) },
  })

  // exams: one timetable per school, kept by the admin; everyone's open page refreshes on a change
  const exams = new Exams(dataDir, {
    isUser: (u) => !!auth.get(u) || u === ENV_ADMIN,
    onChange: () => { for (const u of [...people(), ENV_ADMIN]) store.bus.emit(u, { type: 'exams' }) },
  })
  // the study planner: everyone's own; their other devices pick up a save
  const study = new StudyPlans(dataDir, { onChange: (u, rev) => store.bus.emit(u, { type: 'study', rev }) })
  /** Whoever can manage things: the ADMIN_PASSWORD login and anyone marked admin. */
  const admins = () => [ENV_ADMIN, ...auth.users.filter((x) => x.isAdmin).map((x) => x.username)]

  /** The bot account: BOT_USER in Railway wins, otherwise the admin's pick (Todolist admin → WhatsApp). */
  const envBot = String(process.env.BOT_USER || process.env.WA_BOT_USER || '').trim().toLowerCase() || null
  const botUser = () => {
    const u = envBot || link.settings().bot
    return u && sessions.has(u) ? u : null
  }
  const buddy = new Buddy(dataDir, store, link, { brand, onTaskChange: (t) => toldAdmin(t), getBot: botUser, planner: { study, exams }, nameOf: (u) => nameOf(u) })
  buddy.start(tickMs)
  new Reminders(dataDir, store, push, link, buddy).start(tickMs)

  /** Every Whats Up account, plus the ADMIN_PASSWORD login if it keeps tasks here too. */
  const people = () => {
    const list = auth.users.map((u) => u.username)
    // (only once it has tasks of its own, so it doesn't clutter the people list)
    if (fs.existsSync(store.file(ENV_ADMIN)) && store.snapshot(ENV_ADMIN).tasks.length) list.push(ENV_ADMIN)
    return list
  }
  const nameOf = (u) => store.snapshot(u).profile.name || auth.get(u)?.name || (u === ENV_ADMIN ? 'Admin' : u)
  const tzOf = (u) => store.snapshot(u).profile.tz || push.timezone(u) || 'UTC'

  /** Who's asking, from the Whats Up cookie: { u, admin } or null. */
  function who(req) {
    const c = whoami(req)
    if (c?.k === 'admin') return { u: ENV_ADMIN, admin: true }
    if (c?.k === 'user') {
      const a = auth.get(c.u)
      return a ? { u: a.username, admin: !!a.isAdmin } : null
    }
    return null
  }

  // ------------------------------------------------------------- helpers ---
  function send(res, code, body, headers = {}) {
    // a signed-in request says which version of that person's data it saw or made, so the page
    // can tell its own changes apart from another device's (and skip reloading after its own)
    if (res.revOf && !res.headersSent) {
      try { headers = { ...headers, 'x-rev': String(store.snapshot(res.revOf).rev) } } catch {}
    }
    res.writeHead(code, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      ...headers,
    })
    res.end(body)
  }
  const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' })

  async function readJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Expected application/json')
    const raw = await new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy() } else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
    if (!raw) return {}
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : {}
    } catch {
      throw new HttpError(400, 'Invalid JSON')
    }
  }

  /** The bot account as the pages show it. */
  function botView() {
    const u = botUser()
    if (!u) return null
    const st = link.status(u)
    return { username: u, name: auth.get(u)?.name || u, connected: !!st.connected, status: st.status || 'stopped', phone: st.phone || '' }
  }

  function me(c) {
    const doc = store.snapshot(c.u)
    const wa = link.settings().whatsapp
    const bot = botView()
    const mine = link.status(c.u)
    return {
      username: c.u, name: nameOf(c.u), admin: c.admin, brand, version,
      waReminders: doc.profile.waReminders !== false,
      // 'off', a country code, or a guess from their timezone
      holidayCountry: doc.profile.holidayCountry || countryForTz(doc.profile.tz) || 'off',
      holidayCountries: Object.entries(COUNTRIES).map(([code, x]) => ({ code, name: x.name })),
      appearance: doc.profile.appearance || null,
      tourDone: !!doc.profile.tourDone,
      // where "back to WhatsApp" goes
      home: c.u === ENV_ADMIN ? '/admin' : `/u/${c.u}/`,
      // which WhatsApp features this person can use (the admin can switch them off)
      whatsapp: {
        configured: mine.exists === true,
        reminders: !!wa.reminders, share: !!wa.share, inbox: !!wa.inbox, jump: false,
        buddy: !!wa.reminders && wa.buddy !== false,
        // Buddy writes from the bot's number (and you reply in that chat), unless you picked "Message yourself"
        botNumber: !!bot && bot.username !== c.u && (doc.profile.buddy?.via || 'bot') !== 'self',
        bot: bot && bot.username !== c.u ? { name: bot.name, phone: bot.phone, connected: bot.connected } : null,
        linked: !!mine.connected || !!mine.phone,
        phone: mine.phone || '',
      },
      buddy: { ...BUDDY_DEFAULTS, ...(doc.profile.buddy || {}) },
    }
  }

  function events(req, res, username) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write('retry: 3000\n\n')
    const out = (e) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`) } catch {} }
    store.bus.on(username, out)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25000)
    req.on('close', () => { clearInterval(ping); store.bus.off(username, out) })
    out({ type: 'changed', rev: store.snapshot(username).rev })
  }

  // ------------------------------------------------------- static files ---
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  }
  // the page may sit inside Whats Up (the Todolist tab, and the admin's Todolist tab): same site only
  const FRAME = { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'" }
  function serveStatic(req, res, p) {
    const file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
    if (p !== '/' && p !== '/index.html' && file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      // Vite puts content hashes in /assets/ names, so those can be cached forever
      const cache = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      // the worker looks after the whole site, so Whats Up's own page gets the notifications (and chime) too
      const extra = p === '/sw.js' ? { 'service-worker-allowed': '/', 'cache-control': 'no-cache' } : {}
      return send(res, 200, fs.readFileSync(file), { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': cache, ...extra })
    }
    if (/\.[a-z0-9]{2,5}$/i.test(p)) return send(res, 404, 'Not found', { 'content-type': 'text/plain' })
    // single-page app: every other path is the app (signed in only)
    if (!who(req)) return send(res, 302, '', { location: `/?next=${encodeURIComponent('/todo/' + (p.slice(1) || '') + new URL(req.url, 'http://x').search)}` })
    const index = path.join(DIST, 'index.html')
    if (!fs.existsSync(index)) return send(res, 503, 'Todolist isn’t built. Run `npm run build` in todo/ (the Dockerfile does this).', { 'content-type': 'text/plain; charset=utf-8' })
    return send(res, 200, fs.readFileSync(index), { 'content-type': TYPES['.html'], 'cache-control': 'no-cache', ...FRAME })
  }

  // ---------------------------------------------------------------- admin ---
  async function admin(req, res, p, M, c) {
    if (p === '/api/admin/people' && M === 'GET') {
      const bot = botUser()
      const list = people().map((u) => {
        const doc = store.snapshot(u)
        return {
          username: u,
          name: nameOf(u),
          open: doc.tasks.filter((t) => !t.done).length,
          done: doc.tasks.filter((t) => t.done).length,
          lists: doc.lists.length,
          lastSeen: doc.profile.lastSeen || null,
          devices: push.devices(u).length,
          waReminders: doc.profile.waReminders !== false,
          tz: doc.profile.tz || null,
          // counts only: what's late is nobody's business but theirs
          overdue: doc.tasks.filter((t) => !t.done && t.due && t.due < todayIn(doc.profile.tz || 'UTC')).length,
          tourDone: !!doc.profile.tourDone,
          bot: u === bot,
          // WhatsApp link status (never chats or contacts)
          whatsapp: link.status(u),
        }
      })
      return json(res, list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)))
    }
    if (p === '/api/admin/settings' && M === 'GET') {
      const s = link.settings()
      return json(res, {
        configured: true, whatsapp: s.whatsapp, announcements: s.announcements,
        bot: botView(), botFromEnv: !!envBot,
        accounts: auth.users.map((u) => ({ username: u.username, name: u.name, ...link.status(u.username) })),
      })
    }
    // ---- the big picture: numbers only
    if (p === '/api/admin/overview' && M === 'GET') {
      const week = Date.now() - 7 * 864e5
      const out = { people: 0, active7: 0, open: 0, overdue: 0, doneWeek: 0, notifications: 0, assignments: assignments.all().length, assignedOpen: 0, examRequests: exams.pending(), groups: groups.all().length }
      for (const u of people()) {
        const doc = store.snapshot(u)
        const today = todayIn(doc.profile.tz || 'UTC')
        out.people++
        if ((doc.profile.lastSeen || 0) > week) out.active7++
        if (push.devices(u).length) out.notifications++
        for (const t of doc.tasks) {
          if (!t.done) { out.open++; if (t.due && t.due < today) out.overdue++; if (t.from) out.assignedOpen++ }
          else if ((t.doneAt || 0) > week) out.doneWeek++
        }
      }
      return json(res, out)
    }

    if (p === '/api/admin/assignments' && M === 'GET') return json(res, assignments.all().map(assignmentView))
    // ---- groups: only admins make them and decide who's in them (counts only, never the tasks)
    if (p === '/api/admin/groups' && M === 'GET') {
      return json(res, groups.all().map((g) => ({
        id: g.id, name: g.name, emoji: g.emoji, createdAt: g.createdAt,
        members: g.members.map((m) => ({ username: m, name: nameOf(m) })),
        open: g.tasks.filter((t) => !t.done).length, done: g.tasks.filter((t) => t.done).length,
      })))
    }
    // ---- who's at which school (for the Exams page's Schools panel)
    if (p === '/api/admin/schools/people' && M === 'GET') {
      return json(res, auth.users.map((x) => ({ username: x.username, name: nameOf(x.username), school: exams.mine(x.username).school })).sort((a, b) => a.name.localeCompare(b.name)))
    }
    const body = M === 'DELETE' ? {} : await readJson(req)
    if (p === '/api/admin/groups' && M === 'POST') return json(res, groupView(groups.adminCreate(c.u, body)), 201)
    const gma = p.match(/^\/api\/admin\/groups\/([A-Za-z0-9_-]{6,20})$/)
    if (gma && M === 'PATCH') return json(res, groupView(groups.adminUpdate(gma[1], body)))
    if (gma && M === 'DELETE') return json(res, groups.adminRemove(gma[1]))
    // ---- exams, schools and the requests people send in
    if (p === '/api/admin/exams' && M === 'POST') return json(res, exams.addExam(c.u, body), 201)
    const xm = p.match(/^\/api\/admin\/exams\/([A-Za-z0-9_-]{4,20})$/)
    if (xm && M === 'PATCH') return json(res, exams.updateExam(xm[1], body))
    if (xm && M === 'DELETE') return json(res, exams.deleteExam(xm[1]))
    const rq = p.match(/^\/api\/admin\/exams\/requests\/([A-Za-z0-9_-]{4,20})$/)
    if (rq && M === 'POST') {
      const r = exams.answer(c.u, rq[1], { approve: !!body.approve, changes: body.changes || {}, reason: body.reason || '' })
      const text = r.status === 'added' ? `Added: ${r.subject}${r.paper ? ` ${r.paper}` : ''}, ${r.date}` : `Not added: ${r.subject}${r.paper ? ` ${r.paper}` : ''}${r.reason ? ` (${r.reason})` : ''}`
      store.bus.emit(r.by, { type: 'exams' })
      await push.send(r.by, { title: r.status === 'added' ? '📝 Exam request added' : '📝 Exam request', body: text, tag: `examreq-${r.id}`, kind: 'exam' }).catch(() => {})
      return json(res, r)
    }
    if (p === '/api/admin/schools' && M === 'POST') return json(res, exams.addSchool(body), 201)
    const sm = p.match(/^\/api\/admin\/schools\/([A-Za-z0-9_-]{4,20})$/)
    if (sm && M === 'PATCH') return json(res, exams.updateSchool(sm[1], body))
    if (sm && M === 'DELETE') return json(res, exams.deleteSchool(sm[1]))
    const ps = p.match(/^\/api\/admin\/people\/([a-z0-9._-]{1,40})\/school$/)
    if (ps && M === 'PATCH') return json(res, exams.setSchoolOf(ps[1], body.school || null))
    if (p === '/api/admin/settings' && M === 'POST') {
      const s = link.settings()
      for (const k of ['reminders', 'share', 'inbox', 'buddy']) if (k in (body.whatsapp || {})) s.whatsapp[k] = !!body.whatsapp[k]
      if ('bot' in body) {
        if (envBot) throw new HttpError(409, 'The bot account is set by BOT_USER in Railway. Change it there.')
        const b = body.bot ? String(body.bot).toLowerCase() : null
        if (b && !auth.get(b)) throw new HttpError(404, 'No such Whats Up account')
        s.bot = b
      }
      link.saveSettings(s)
      return json(res, { ok: true, whatsapp: s.whatsapp, bot: botView() })
    }
    // ---- check the bot: is it online, and send the admin a hello from it
    if (p === '/api/admin/test' && M === 'POST') {
      const bot = botView()
      if (!bot) return json(res, { ok: true, bot: null })
      if (!bot.connected) throw new HttpError(503, `Bot “${bot.name}” isn’t connected (${bot.status}). Sign in as it and scan the QR code.`)
      if (c.u === ENV_ADMIN || c.u === bot.username) return json(res, { ok: true, bot, sent: false })
      const jid = await buddy.jidOf(c.u)
      if (!jid) throw new HttpError(400, 'Link your own WhatsApp first.')
      await link.call('send', { username: bot.username, jid, text: `👋 Hi ${nameOf(c.u).split(' ')[0]}, Buddy here. The bot works.\nReply *help* for commands.` })
      return json(res, { ok: true, bot, sent: true })
    }
    if (p === '/api/admin/announce' && M === 'POST') {
      const title = String(body.title || '').trim().slice(0, 80)
      const text = String(body.body || '').trim().slice(0, 500)
      const to = body.to && body.to !== 'all' ? String(body.to) : 'all'
      if (!title) throw new HttpError(400, 'Give the announcement a title')
      if (to !== 'all' && !people().includes(to)) throw new HttpError(404, 'No such person')
      const a = { id: Math.random().toString(36).slice(2, 10), title, body: text, to, at: Date.now(), by: c.u }
      const s = link.settings()
      s.announcements = [a, ...s.announcements].slice(0, 30)
      link.saveSettings(s)
      let sent = 0
      for (const u of to === 'all' ? people() : [to]) {
        sent += (await push.send(u, { title: `📣 ${title}`, body: text, tag: `announce-${a.id}`, kind: 'announcement' })).sent
        store.bus.emit(u, { type: 'announcement', id: a.id })
      }
      return json(res, { ok: true, announcement: a, pushed: sent })
    }
    // ---- show someone the tutorial again (next time they open the app)
    const tm = p.match(/^\/api\/admin\/people\/([a-z0-9._-]{1,40})\/tour$/)
    if (tm && M === 'POST') {
      if (!people().includes(tm[1])) throw new HttpError(404, 'No such person')
      store.setProfile(tm[1], { tourDone: false })
      return json(res, { ok: true })
    }

    // ---- give people a task
    if (p === '/api/admin/assignments' && M === 'POST') {
      const everyone = people()
      // "Everyone" means everyone but you (and the bot); pick yourself by name if you want a copy too
      const to = body.to === 'all'
        ? everyone.filter((u) => u !== c.u && u !== botUser() && u !== ENV_ADMIN)
        : [...new Set((Array.isArray(body.to) ? body.to : []).map(String))].filter((u) => everyone.includes(u))
      if (!to.length) throw new HttpError(400, 'Choose who gets the task')
      const t = body.task || {}
      const fields = {
        title: t.title, notes: t.notes, due: t.due || null, time: t.time || null, priority: t.priority, repeat: t.repeat || null,
        tags: t.tags, links: t.links,
        subtasks: (Array.isArray(t.subtasks) ? t.subtasks : []).map((x) => ({ title: typeof x === 'string' ? x : x?.title })),
      }
      // a time means a reminder at that time, like a task you add yourself
      if (fields.time && fields.due) fields.remind = 0
      const clean = store.checkTask(fields) // a bad field fails here, before anyone gets anything
      const byName = nameOf(c.u)
      const rec = { id: assignments.newId(), title: clean.title, notes: clean.notes, due: clean.due, time: clean.time, priority: clean.priority, repeat: clean.repeat, steps: clean.subtasks.length, at: Date.now(), by: c.u, byName, to }
      const from = { by: c.u, name: byName, assignment: rec.id }
      const waOk = !!body.whatsapp && link.enabled('reminders')
      let pushed = 0, whatsapp = 0
      const failed = []
      for (const u of to) {
        let task
        try { task = store.addTask(u, fields, { from }) } catch (e) { failed.push({ username: u, error: e.message }); continue }
        store.bus.emit(u, { type: 'assigned', id: rec.id, taskId: task.id, title: task.title, by: byName })
        pushed += (await push.send(u, { title: `📌 New task from ${byName}`, body: [task.title, task.due && formatWhen(task)].filter(Boolean).join(' · '), tag: `assign-${rec.id}`, taskId: task.id, kind: 'assigned' })).sent
        // "also tell them on WhatsApp": from the bot when there is one; without a bot only into the
        // "Message yourself" chat of people who asked for WhatsApp reminders
        if (waOk && (buddy.viaBot(u) || store.snapshot(u).profile.waReminders !== false)) {
          try {
            await buddy.send(u, `📌 *${byName} gave you a task*\n\n${taskMessage(task, { today: todayIn(tzOf(u)), brand })}`, { kind: 'assignment' })
            buddy.remember(u, [task.id])
            whatsapp++
          } catch (e) { console.warn(`[todo/assign] ${u}: WhatsApp failed: ${e.message}`) }
        }
      }
      if (failed.length === to.length) throw new HttpError(400, failed[0].error)
      rec.to = to.filter((u) => !failed.some((f) => f.username === u))
      assignments.add(rec)
      console.log(`[todo/assign] ${c.u} → ${rec.to.length} people: "${rec.title}"`)
      return json(res, { ok: true, assignment: assignmentView(rec), pushed, whatsapp, failed }, 201)
    }
    const am = p.match(/^\/api\/admin\/assignments\/([A-Za-z0-9_-]{1,20})(\/remind)?$/)
    if (am) {
      const rec = assignments.get(am[1])
      if (!rec) throw new HttpError(404, 'That assignment no longer exists')
      // nudge everyone who hasn't finished it yet
      if (am[2] && M === 'POST') {
        let n = 0, pushed = 0, whatsapp = 0
        for (const u of rec.to) {
          const pr = progressOf(store.tasksFrom(u, rec.id))
          if (pr.status === 'done' || pr.status === 'removed') continue
          n++
          store.bus.emit(u, { type: 'nudge', id: rec.id, taskId: pr.taskId, title: rec.title, by: rec.byName })
          pushed += (await push.send(u, { title: `👋 Reminder from ${rec.byName}`, body: rec.title, tag: `nudge-${rec.id}`, taskId: pr.taskId, kind: 'nudge' })).sent
          if (body.whatsapp && link.enabled('reminders') && pr.taskId && (buddy.viaBot(u) || store.snapshot(u).profile.waReminders !== false)) {
            const task = store.snapshot(u).tasks.find((x) => x.id === pr.taskId)
            try {
              if (task) { await buddy.send(u, `👋 *${rec.byName} is checking on this*\n\n${buddy.taskMessage(u, task)}`, { kind: 'nudge' }); buddy.remember(u, [task.id]); whatsapp++ }
            } catch (e) { console.warn(`[todo/nudge] ${u}: WhatsApp failed: ${e.message}`) }
          }
        }
        return json(res, { ok: true, people: n, pushed, whatsapp })
      }
      // forget it (?withdraw=1 also takes the unfinished tasks back from everyone)
      if (!am[2] && M === 'DELETE') {
        let removed = 0, people = 0
        if (new URL(req.url, 'http://x').searchParams.get('withdraw') === '1') {
          for (const u of rec.to) {
            const n = store.withdrawAssignment(u, rec.id)
            removed += n
            if (n) people++
          }
        }
        assignments.remove(rec.id)
        return json(res, { ok: true, removed, people })
      }
    }

    const m = p.match(/^\/api\/admin\/announce\/([a-z0-9]{1,20})$/)
    if (m && M === 'DELETE') {
      const s = link.settings()
      s.announcements = s.announcements.filter((a) => a.id !== m[1])
      link.saveSettings(s)
      return json(res, { ok: true })
    }
    throw new HttpError(404, 'Not found')
  }

  /** An assignment plus where each person is with it (only that one task, nothing else of theirs). */
  function assignmentView(rec) {
    const list = rec.to.map((u) => {
      const pr = progressOf(store.tasksFrom(u, rec.id))
      return { username: u, name: nameOf(u), status: pr.status, doneAt: pr.doneAt, rounds: pr.rounds }
    })
    const count = (st) => list.filter((x) => x.status === st).length
    return { ...rec, people: list, counts: { todo: count('todo'), doing: count('doing'), done: count('done'), removed: count('removed') } }
  }
  /** Someone changed or deleted a task the admin gave them: the admin's open Admin page refreshes its progress. */
  function toldAdmin(task) {
    if (task?.from?.by) store.bus.emit(task.from.by, { type: 'assignment', id: task.from.assignment })
    return task
  }
  const formatWhen = (t) => `${t.due}${t.time ? ` ${t.time}` : ''}`

  // ------------------------------------------------------------- the API ---
  async function api(req, res, p, url) {
    const M = req.method
    const c = who(req)
    if (!c) throw new HttpError(401, 'Please sign in again')
    const u = c.u
    res.revOf = u

    if (p === '/api/me' && M === 'GET') { store.touch(u); return json(res, me(c)) }
    // the little number on the Todolist button in Whats Up
    if (p === '/api/badge' && M === 'GET') {
      const doc = store.snapshot(u)
      const today = todayIn(tzOf(u))
      const mineInGroups = groups.mine(u).flatMap((g) => g.tasks.filter((t) => t.assignee === u))
      const open = [...doc.tasks, ...mineInGroups].filter((t) => !t.done && t.due && t.due <= today)
      return json(res, { due: open.length, overdue: open.filter((t) => t.due < today).length })
    }
    // "Add to todolist" on a WhatsApp message: what the text says (title, date, time) before saving it
    if (p === '/api/parse' && M === 'GET') {
      const doc = store.snapshot(u)
      const raw = String(url.searchParams.get('text') || '').slice(0, 2000).trim()
      // chat punctuation ("friday 5pm?") shouldn't hide a date; the title is the first sentence
      const clean = (x) => x.replace(/[?!,;:]+(?=\s|$)/g, ' ').replace(/\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
      const first = raw.split(/(?<=[.?!])\s+/)[0] || raw
      const today = todayIn(tzOf(u))
      const whole = parseQuickAdd(clean(raw), [], today)
      const head = parseQuickAdd(clean(first), [], today)
      let title = head.title || clean(first)
      for (let i = 0; i < 3; i++) title = title.replace(/\s+(by|on|at|before|until|for|this|next|the)$/i, '')
      return json(res, { title, due: whole.due ?? head.due ?? null, time: whole.time ?? head.time ?? null })
    }
    // everyone you can share a group with (names only)
    if (p === '/api/people' && M === 'GET') {
      return json(res, auth.users.map((x) => ({ username: x.username, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)))
    }
    // ---- groups
    if (p === '/api/groups' && M === 'GET') return json(res, groups.mine(u).map(groupView))
    // ---- your tasks in your phone's calendar
    if (p === '/api/calendar' && M === 'GET') return json(res, { url: calendarUrl(req, calendars.token(u)) })
    if (p === '/api/calendar/renew' && M === 'POST') return json(res, { url: calendarUrl(req, calendars.token(u, true)) })
    if (p === '/api/holidays' && M === 'GET') {
      const doc = store.snapshot(u)
      const country = url.searchParams.get('country') || doc.profile.holidayCountry || countryForTz(doc.profile.tz) || 'off'
      const from = Math.max(2000, Math.min(2100, Number(url.searchParams.get('from')) || new Date().getFullYear()))
      const to = Math.max(from, Math.min(from + 2, Number(url.searchParams.get('to')) || from))
      return json(res, await holidays.get(country, from, to))
    }
    if (p === '/api/announcements' && M === 'GET') {
      const since = Date.now() - 30 * 864e5
      return json(res, link.settings().announcements.filter((a) => a.at > since && (a.to === 'all' || a.to === u)).slice(0, 5))
    }
    if (p === '/api/wa/status' && M === 'GET') return json(res, link.status(u))
    if (p === '/api/wa/chats' && M === 'GET') {
      link.require('share')
      return json(res, await link.call('chats', { username: u, q: String(url.searchParams.get('q') || '').slice(0, 60) }))
    }
    if (p.startsWith('/api/admin/')) {
      if (!c.admin) throw new HttpError(403, 'Admins only')
      return admin(req, res, p, M, c)
    }
    if (p === '/api/data' && M === 'GET') return json(res, store.snapshot(u))
    let gm = p.match(/^\/api\/groups\/([A-Za-z0-9_-]{6,20})(?:\/(leave|clear-done|tasks)(?:\/([A-Za-z0-9_-]{1,20}))?)?$/)
    if (gm && M !== 'GET') {
      const body = M === 'DELETE' ? {} : await readJson(req)
      const [, gid, what, tid] = gm
      // who's in a group, its name and the group itself are the admin's to change
      if ((!what && (M === 'PATCH' || M === 'DELETE')) || what === 'leave') throw new HttpError(403, 'Only an admin can change groups')
      if (what === 'clear-done' && M === 'POST') return json(res, groups.clearDone(u, gid))
      if (what === 'tasks' && !tid && M === 'POST') return json(res, groups.addTask(u, gid, body), 201)
      if (what === 'tasks' && tid && M === 'PATCH') return json(res, groups.updateTask(u, gid, tid, body))
      if (what === 'tasks' && tid && M === 'DELETE') return json(res, groups.deleteTask(u, gid, tid))
      throw new HttpError(404, 'Not found')
    }
    if (p === '/api/groups' && M === 'POST') throw new HttpError(403, 'Only an admin can make groups')
    // ---- exams: your school's timetable (admins: any school, or ?school=all)
    if (p === '/api/exams' && M === 'GET') {
      const v = exams.view(u, { admin: c.admin, school: url.searchParams.get('school') || undefined })
      return json(res, { ...v, admin: c.admin, requests: v.requests.map((r) => ({ ...r, byName: nameOf(r.by) })) })
    }
    if (p === '/api/exams/me' && M === 'PATCH') return json(res, exams.setMine(u, await readJson(req)))
    if (p === '/api/exams/requests' && M === 'POST') {
      const r = exams.request(u, await readJson(req))
      // tell the admins (their open Exams page shows it; a push if they have notifications on)
      for (const a of admins()) {
        if (a === u) continue
        store.bus.emit(a, { type: 'exams' })
        push.send(a, { title: '📝 Exam request', body: `${nameOf(u)}: ${r.subject}${r.paper ? ` ${r.paper}` : ''}, ${r.date}`, tag: `examreq-${r.id}`, kind: 'exam' }).catch(() => {})
      }
      return json(res, r, 201)
    }
    const wr = p.match(/^\/api\/exams\/requests\/([A-Za-z0-9_-]{4,20})$/)
    if (wr && M === 'DELETE') return json(res, exams.withdraw(u, wr[1]))
    // ---- the study planner (yours only)
    if (p === '/api/study' && M === 'GET') return json(res, study.get(u))
    if (p === '/api/study' && M === 'PUT') return json(res, study.put(u, await readJson(req)))
    if (p === '/api/events' && M === 'GET') return events(req, res, u)
    if (p === '/api/push/key' && M === 'GET') return json(res, { key: push.publicKey, devices: push.devices(u).length })

    if (M === 'GET') throw new HttpError(404, 'Not found')
    const body = M === 'DELETE' ? {} : await readJson(req)

    if (p === '/api/profile' && M === 'PATCH') {
      store.setProfile(u, body)
      return json(res, me(c))
    }
    if (p === '/api/push/subscribe' && M === 'POST') return json(res, push.subscribe(u, body))
    if (p === '/api/push/unsubscribe' && M === 'POST') return json(res, push.unsubscribe(u, String(body.endpoint || '')))
    if (p === '/api/push/test' && M === 'POST') {
      // with `endpoint`: just this device, so you find out whether *this* one works
      const only = typeof body.endpoint === 'string' && push.devices(u).some((d) => d.subscription.endpoint === body.endpoint) ? body.endpoint : null
      const r = await push.send(u, { title: '🔔 Test notification', body: 'Reminders will look like this.', tag: `test-${Date.now()}`, kind: 'test' }, { only })
      if (!r.devices) throw new HttpError(409, 'This device isn’t subscribed anymore. Turn notifications off and on again.')
      if (!r.sent) {
        const e = r.errors[0]
        throw new HttpError(502, `Push service (${e?.host || '?'}) rejected it${e?.status ? ` (${e.status})` : ''}. Turn notifications off and on again.`)
      }
      return json(res, r)
    }
    if (p === '/api/wa/share' && M === 'POST') {
      link.require('share')
      const doc = store.snapshot(u)
      const task = doc.tasks.find((t) => t.id === body.taskId)
      if (!task) throw new HttpError(404, 'That task no longer exists')
      const jid = String(body.jid || '')
      if (!/^[0-9a-z.:_-]+@(s\.whatsapp\.net|g\.us|lid)$/i.test(jid)) throw new HttpError(400, 'Pick a chat to send to')
      const list = task.listId && doc.lists.find((l) => l.id === task.listId)
      const text = taskMessage(task, { today: todayIn(tzOf(u)), listName: list ? `${list.emoji} ${list.name}` : '', brand })
      await link.call('send', { username: u, jid, text })
      return json(res, { ok: true })
    }
    if (p === '/api/wa/test-reminder' && M === 'POST') {
      link.require('reminders')
      await buddy.send(u, '🔔 *Test reminder*\nYour reminders will show up here.', { kind: 'reminder' })
      return json(res, { ok: true })
    }
    // WhatsApp Buddy: send me an example now (a task reminder, the morning brief or the evening check-in)
    if (p === '/api/buddy/test' && M === 'POST') {
      link.require('reminders')
      if (!buddy.available) throw new HttpError(403, 'Your admin has turned WhatsApp Buddy off.')
      const kind = ['task', 'morning', 'evening', 'help', 'study', 'exams'].includes(body.kind) ? body.kind : 'task'
      let text
      if (kind === 'morning') text = buddy.morningMessage(u)
      else if (kind === 'study') text = buddy.studyMessage(u, todayIn(tzOf(u)))
      else if (kind === 'exams') text = buddy.upcomingExams(u)
      else if (kind === 'evening') text = buddy.eveningMessage(u)
      else if (kind === 'help') text = buddy.helpMessage(u)
      else {
        const open = store.snapshot(u).tasks.filter((t) => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99'))
        const t = open[0] || { id: 'demo', title: 'Drink some water', notes: 'Example reminder.', due: null, time: null, priority: 1, subtasks: [], tags: [], status: 'todo' }
        text = buddy.taskMessage(u, t)
        if (open[0]) buddy.remember(u, [open[0].id])
      }
      await buddy.send(u, text, { kind: kind === 'task' ? 'test' : kind })
      return json(res, { ok: true })
    }
    let dm = p.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})$/)
    if (dm && M === 'PUT') return json(res, store.setDayNote(u, dm[1], body))
    if (dm && M === 'DELETE') return json(res, store.deleteDayNote(u, dm[1]))
    if (p === '/api/tasks' && M === 'POST') return json(res, store.addTask(u, body), 201)
    if (p === '/api/tasks/reorder' && M === 'POST') return json(res, store.reorderTasks(u, body.ids))
    if (p === '/api/tasks/clear-completed' && M === 'POST') return json(res, store.clearCompleted(u, body.listId || null))
    let m = p.match(/^\/api\/tasks\/([A-Za-z0-9_-]{1,20})$/)
    if (m && M === 'PATCH') return json(res, toldAdmin(store.updateTask(u, m[1], body)))
    if (m && M === 'DELETE') return json(res, toldAdmin(store.deleteTask(u, m[1])))

    if (p === '/api/lists' && M === 'POST') return json(res, store.addList(u, body), 201)
    if (p === '/api/lists/restore' && M === 'POST') return json(res, store.restoreList(u, body), 201)
    if (p === '/api/board' && M === 'PUT') return json(res, store.saveBoard(u, body))
    if (p === '/api/lists/reorder' && M === 'POST') return json(res, store.reorderLists(u, body.ids))
    m = p.match(/^\/api\/lists\/([A-Za-z0-9_-]{1,20})$/)
    if (m && M === 'PATCH') return json(res, store.updateList(u, m[1], body))
    if (m && M === 'DELETE') return json(res, store.deleteList(u, m[1], { deleteTasks: url.searchParams.get('tasks') === 'delete' }))

    throw new HttpError(404, 'Not found')
  }

  // ------------------------------------------------ WhatsApp → Todolist ---
  const seen = new Set()
  const firstTime = (k) => {
    if (seen.has(k)) return false
    seen.add(k)
    if (seen.size > 5000) seen.clear()
    return true
  }
  const lastHelp = new Map()
  const SMALL_TALK = /^(thanks?|thank you|thx|ty|tq|ok(ay)?|oke|okey|sip|siap|mantap|nice|cool|great|noted|alright|terima ?kasih|makasih|👍|🙏|❤️|😊|🙂|👌)[\s.!]*$/i

  /** A message sent to the bot: the reply (or null to stay quiet). */
  function botReply(u, text) {
    const raw = String(text || '').trim()
    const prefixed = isTodoCommand(raw)
    const body = prefixed ? stripTodo(raw) : raw
    const low = body.toLowerCase()
    const tz = tzOf(u)
    if (/^(hi|hello|hey|halo|hai|hallo|start|menu|yo)[\s.!]*$/.test(low)) {
      return `👋 Hi ${nameOf(u).split(' ')[0]}, I’m Buddy from ${brand}.\n\n${buddy.helpMessage(u)}`
    }
    let m
    if ((m = body.match(/^(?:add|new|todo|task|tambah)\s*:?\s+(.+)$/is))) {
      if (!link.enabled('inbox')) return 'Adding tasks from WhatsApp is turned off.'
      return handleInbox(store, u, `todo: ${m[1]}`, { tz, brand }).reply
    }
    if (!buddy.available) return null
    const r = buddy.command(u, body)
    if (r) return r.reply
    if (prefixed) {
      if (!link.enabled('inbox')) return 'Adding tasks from WhatsApp is turned off.'
      return handleInbox(store, u, raw, { tz, brand }).reply
    }
    if (SMALL_TALK.test(body)) return null
    // don't lecture twice in a row
    if (Date.now() - (lastHelp.get(u) || 0) < 10 * 60e3) return null
    lastHelp.set(u, Date.now())
    return 'Didn’t get that. Try *today*, *add* buy milk 5pm, *done*, *snooze 1h* or *help*.'
  }

  async function onWhatsApp(username, s, msg) {
    if (!msg?.text || msg.deleted || msg.type !== 'text') return
    if (Date.now() - Number(msg.ts || 0) * 1000 > 10 * 60e3) return // old news after a reconnect
    if (!firstTime(`${username}|${msg.id}`)) return
    let jid = s.store.canon(msg.jid)
    // WhatsApp's anonymous ids (LIDs): ask for the phone number behind it, so we know who wrote
    if (jid.endsWith('@lid')) {
      try {
        const pn = await s.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid)
        const bare = typeof pn === 'string' ? pn.replace(/:\d+(?=@)/, '') : null
        if (bare?.endsWith('@s.whatsapp.net')) { s.store.link?.(jid, bare); jid = bare }
      } catch {}
    }
    const bot = botUser()

    // ---- someone wrote to the bot
    if (username === bot) {
      if (msg.fromMe || !jid.endsWith('@s.whatsapp.net')) return
      const u = await buddy.userOfJid(jid, people())
      if (!u) return // not one of us: the bot stays quiet
      let reply
      try { reply = botReply(u, msg.text) } catch (e) { reply = `⚠️ ${e.message}` }
      if (reply) await link.call('send', { username: bot, jid, text: plain(reply) })
      return
    }

    // ---- "td …" in your own "Message yourself" chat
    const self = s.me?.jid && s.store.canon(s.me.jid)
    if (!msg.fromMe || !self || jid !== self || !isTodoCommand(msg.text)) return
    if (!link.enabled('inbox') && !buddy.available) return
    let reply
    const selfBody = stripTodo(msg.text)
    try {
      const quick = selfBody.match(/^(?:add|new|todo|task|tambah)\s*:?\s+(.+)$/is)
      if (quick) {
        if (!link.enabled('inbox')) return
        reply = handleInbox(store, username, `todo: ${quick[1]}`, { tz: tzOf(username), brand }).reply
      } else {
        reply = (buddy.available ? buddy.command(username, selfBody) : null)?.reply
      }
      if (!reply) {
        if (!link.enabled('inbox')) return
        reply = handleInbox(store, username, msg.text, { tz: tzOf(username), brand }).reply
      }
    } catch (e) { reply = `⚠️ ${e.message}` }
    await link.call('send', { username, text: reply })
  }

  /** Listen to one Whats Up account's WhatsApp (call for every session, including new ones). */
  function attach(username, s) {
    s.on('wa:new', (msg) => onWhatsApp(username, s, msg).catch((e) => console.warn(`[todo/whatsapp] ${username}: ${e.message}`)))
  }

  /** A group as members see it: names for everyone in it. */
  function groupView(g) {
    return { ...g, members: g.members.map((m) => ({ username: m, name: nameOf(m) })) }
  }

  const calendarUrl = (req, token) => {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http'
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}/todo/cal/${token}.ics`
  }
  function feed(req, res, token) {
    const u = calendars.owner(token)
    if (!u) return send(res, 404, 'Not found', { 'content-type': 'text/plain' })
    const doc = store.snapshot(u)
    const items = [
      ...doc.tasks.filter((t) => t.due && !t.done).map((task) => ({ task })),
      ...groups.mine(u).flatMap((g) => g.tasks.filter((t) => t.due && !t.done && (!t.assignee || t.assignee === u)).map((task) => ({ task, group: g }))),
      // your school's exams (your subjects, if you picked some), with a reminder the day before
      ...exams.examsFor(u).map((e) => ({
        minutes: e.minutes || 60,
        task: {
          id: `exam-${e.id}`, title: `📝 ${e.subject}${e.paper ? ` ${e.paper}` : ''}`, due: e.date, time: e.start, remind: e.start ? 24 * 60 : null,
          notes: [e.venue && `Venue: ${e.venue}`, e.who, e.notes].filter(Boolean).join('\n'), subtasks: [], updatedAt: e.at,
        },
      })),
    ]
    const body = calendars.ics({ name: `${brand} · ${nameOf(u)}`, tz: tzOf(u), items, host: String(req.headers['x-forwarded-host'] || req.headers.host || 'todo').replace(/[^a-z0-9.:-]/gi, '') })
    return send(res, 200, body, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache', 'content-disposition': 'inline; filename="todolist.ics"' })
  }

  /** A Whats Up account was removed: put its todolist aside (kept on the volume, not shown to anyone). */
  function forget(username) {
    if (!USERNAME_RE.test(username)) return
    try {
      const dir = path.join(dataDir, 'removed')
      fs.mkdirSync(dir, { recursive: true })
      if (fs.existsSync(store.file(username))) fs.renameSync(store.file(username), path.join(dir, `${username}-${Date.now()}.json`))
      store.docs.delete(username)
      // their notification devices and Buddy's notes (their number) go too, so a new account
      // with the same username starts clean
      fs.rmSync(push.file(username), { force: true })
      buddy.forget(username)
      groups.forget(username)
      calendars.forget(username)
      exams.forget(username)
      study.forget(username)
    } catch (e) { console.warn(`[todo] couldn't put ${username}'s todolist aside: ${e.message}`) }
  }

  /** Handles /todo and everything under it. Returns false for any other address. */
  async function handle(req, res, url) {
    const p = url.pathname
    if (p === '/todo') return send(res, 302, '', { location: '/todo/' + url.search }), true
    if (!p.startsWith('/todo/')) return false
    const sub = p.slice('/todo'.length) // "/", "/api/…", "/assets/…"
    // the calendar feed: no cookie (calendar apps fetch it), the secret in the address is the key
    const cm = sub.match(/^\/cal\/([A-Za-z0-9_-]{20,64})\.ics$/)
    if (cm) return feed(req, res, cm[1]), true
    if (sub.startsWith('/api/')) await api(req, res, sub, url)
    else serveStatic(req, res, sub)
    return true
  }

  return { handle, attach, forget, store, buddy, link, who }
}
