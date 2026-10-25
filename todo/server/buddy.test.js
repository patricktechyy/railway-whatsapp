import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store.js'
import { Buddy, snoozeUntil, waInstant, waSig, parseCommand, CODE_RE } from './buddy.js'
import { zonedTime, todayIn } from './tz.js'
import { Reminders } from './reminders.js'

const TZ = 'Asia/Singapore'
/** A stand-in for the WhatsApp link: remembers what would have been sent. */
function setup({ features = {}, bot = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-'))
  const store = new Store(dir)
  const sent = []
  const link = {
    settings: () => ({ whatsapp: { reminders: true, buddy: true, ...features } }),
    enabled: (f) => link.settings().whatsapp[f] !== false,
    call: async (ep, p) => {
      if (ep === 'status') return { phone: '+65 9123 4567' }
      sent.push({ ep, ...p })
      if (ep === 'send' || ep === 'poll') return { ok: true, id: `msg-${sent.length}`, jid: p.jid || '6591234567@s.whatsapp.net' }
      if (ep === 'delete-message') return { ok: true }
      return { ok: true }
    },
  }
  process.env.WA_BOT_USER = bot
  const changed = []
  const buddy = new Buddy(dir, store, link, { brand: 'Test', onTaskChange: (t) => changed.push(t) })
  store.setProfile('gavin', { name: 'Gavin Tan', tz: TZ })
  return { store, buddy, sent, changed }
}

test('snooze times', () => {
  const now = zonedTime('2026-10-04', '14:00', TZ)
  assert.equal(snoozeUntil('30m', TZ, now), now + 30 * 60e3)
  assert.equal(snoozeUntil('2 hours', TZ, now), now + 2 * 3600e3)
  assert.equal(snoozeUntil('', TZ, now), now + 3600e3)
  assert.equal(snoozeUntil('tonight', TZ, now), zonedTime('2026-10-04', '20:00', TZ))
  assert.equal(snoozeUntil('tomorrow', TZ, now), zonedTime('2026-10-05', '09:00', TZ))
  assert.equal(snoozeUntil('3pm', TZ, now), zonedTime('2026-10-04', '15:00', TZ))
  assert.equal(snoozeUntil('9am', TZ, now), zonedTime('2026-10-05', '09:00', TZ)) // already past today → tomorrow
  assert.equal(snoozeUntil('next week', TZ, now), null)
  assert.equal(snoozeUntil('99d', TZ, now), null)
})

test('a WhatsApp reminder: exact or relative to the due time, re-armed when things change', () => {
  const t = { due: '2026-10-04', time: '16:00', wa: { before: 30 } }
  assert.equal(waInstant(t, TZ), zonedTime('2026-10-04', '15:30', TZ))
  const sig = waSig(t)
  assert.notEqual(waSig({ ...t, time: '17:00' }), sig)
  assert.equal(waInstant({ wa: { before: 0 } }, TZ), null) // relative needs a date
  assert.equal(waInstant({ wa: { at: 123 } }, TZ), 123)
})

test('task.wa is validated', () => {
  const { store } = setup()
  assert.throws(() => store.addTask('gavin', { title: 'x', wa: { at: 5 } }), /within the next year/)
  assert.throws(() => store.addTask('gavin', { title: 'x', wa: { before: -1 } }), /Invalid/)
  assert.deepEqual(store.addTask('gavin', { title: 'x', wa: { before: 15, sent: 'fake' } }).wa, { before: 15 }) // "sent" is the server's
  assert.equal(store.addTask('gavin', { title: 'y', wa: null }).wa, null)
})

test('the clock: sends each reminder once, skips stale ones, morning brief once a day', async () => {
  const { store, buddy, sent } = setup()
  const now = Date.now()
  store.addTask('gavin', { title: 'Due now', wa: { at: now - 1000 } })
  store.addTask('gavin', { title: 'Later', wa: { at: now + 3600e3 } })
  store.addTask('gavin', { title: 'Way overdue', wa: { at: now - 13 * 3600e3 } })
  store.setProfile('gavin', { buddy: { on: true, style: 'friendly', morning: '00:00', evening: null } })
  await buddy.tick(now)
  await buddy.tick(now + 1000)
  const msgs = sent.filter((x) => x.ep === 'send')
  assert.equal(msgs.filter((m) => m.text.includes('Due now')).length, 1)
  assert.ok(!msgs.some((m) => m.text.includes('*Later*') || m.text.includes('*Way overdue*')))
  const morning = zonedTime(todayIn(TZ, now), '00:00', TZ)
  const briefs = msgs.filter((m) => /Good morning|Morning Gavin/.test(m.text))
  assert.equal(briefs.length, now - morning <= 3 * 3600e3 ? 1 : 0) // only within 3h of its time
  assert.equal(store.snapshot('gavin').tasks.find((t) => t.title === 'Way overdue').wa.sent !== undefined, true)
})

test('admin switch off → silent', async () => {
  const { store, buddy, sent } = setup({ features: { buddy: false } })
  store.addTask('gavin', { title: 'Due now', wa: { at: Date.now() - 1000 } })
  await buddy.tick()
  assert.equal(sent.length, 0)
})

test('the bot number: messages go to your phone from the bot account', async () => {
  const { store, buddy, sent } = setup({ bot: 'buddybot' })
  // private by default: your own "Message yourself" chat, even with a bot number set up
  await buddy.send('gavin', 'hi')
  assert.equal(sent.at(-1).username, 'gavin')
  // an old saved "bot" that was never actually chosen doesn't count
  store.setProfile('gavin', { buddy: { via: 'bot' } })
  await buddy.send('gavin', 'hi')
  assert.equal(sent.at(-1).username, 'gavin')
  // only once you pick Buddy's number yourself
  store.setProfile('gavin', { buddy: { via: 'bot', viaChosen: true } })
  await buddy.send('gavin', 'hi')
  assert.deepEqual(sent.at(-1), { ep: 'send', username: 'buddybot', jid: '6591234567@s.whatsapp.net', text: 'hi' })
  process.env.WA_BOT_USER = ''
})

test('plain(): messages from the bot number drop the "td" (you just reply there)', async () => {
  const { plain } = await import('./buddy.js')
  assert.equal(plain('↩️ Reply *td done* · *td start* · *td snooze 1h*'), '↩️ Reply *done* · *start* · *snooze 1h*')
  assert.equal(plain('_td done 1 · td start 2 · td snooze 3 2h_'), '_done 1 · start 2 · snooze 3 2h_')
  assert.equal(plain('Send *td?* for today’s list'), 'Send *today* for today’s list')
  assert.equal(plain('• *td:* buy milk tomorrow 5pm'), '• *add* buy milk tomorrow 5pm')
  assert.equal(plain('_Add one: “td: gym 6pm”_'), '_Add one: “add gym 6pm”_')
  assert.equal(plain('🤖 *Buddy commands* (start with *td*):'), '🤖 *Buddy commands* (just reply here):')
  assert.equal(plain('get the std dev'), 'get the std dev')
})

test('the study plan on WhatsApp: bullets with tick numbers, a blank line between subjects', () => {
  const { buddy } = setup()
  let plan = {
    subjects: [{ id: 'm', name: 'Mathematics', priority: false }, { id: 'b', name: 'Biology', priority: true }],
    tags: [], days: {},
    blocks: [
      { id: 'x1', date: '2026-10-09', subject: 'm', mode: 'RE', time: '18:00', minutes: 90, topics: [{ id: 't1', text: 'All units', done: false }], note: '', order: 1 },
      { id: 'x2', date: '2026-10-09', subject: 'b', mode: 'RE', time: '20:00', minutes: 120, topics: [{ id: 't2', text: 'All applicable units', done: false }], note: 'For Biology Paper 3 on 13 Oct', order: 2 },
    ],
  }
  buddy.planner = { study: { get: () => plan, update: (u, fn) => { plan = fn(JSON.parse(JSON.stringify(plan))); return plan } } }
  const msg = buddy.studyMessage('gavin', '2026-10-09', zonedTime('2026-10-09', '07:00', TZ))
  const lines = msg.split('\n')
  const maths = lines.findIndex((l) => l.startsWith('*Mathematics*'))
  assert.deepEqual(lines.slice(maths, maths + 6), [
    '*Mathematics* · RE · 6:00 PM · 90 min',
    '• All units (1)',
    '',
    '🔴 *Biology* · RE · 8:00 PM · 120 min',
    '• All applicable units (2)',
    '_For Biology Paper 3 on 13 Oct_',
  ])
  assert.ok(!/^\s*\d+\.\s/m.test(msg), 'no line starts like a numbered list')
  // the numbers in brackets are what "tick" uses
  assert.match(buddy.tickTopic('gavin', 2), /All applicable units/)
  assert.equal(plan.blocks[1].topics[0].done, true)
})

test('a task added after its reminder time has passed doesn’t message straight away', async () => {
  const { store, buddy, sent } = setup()
  const today = todayIn(TZ)
  const now = zonedTime(today, '20:00', TZ)
  const t = store.addTask('gavin', { title: 'Read a book', due: today, wa: { before: 0 } }) // "on the day" = 9 AM, long gone
  store.change('gavin', (doc) => { doc.tasks.find((x) => x.id === t.id).createdAt = now - 60e3; return null })
  await buddy.tick(now)
  assert.ok(!sent.some((x) => /Read a book/.test(x.text || '')))
})

test('a task with a bell and "WhatsApp me" at the same time: one WhatsApp message, not two', async () => {
  const { store, buddy, sent } = setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-')); fs.mkdirSync(path.join(dir, 'push'))
  const pushed = []
  const push = { devices: () => [{}], timezone: () => TZ, send: async (u, n) => { pushed.push(n); return { sent: 1 } } }
  const link = { enabled: () => true, call: async () => ({}) }
  const rem = new Reminders(dir, store, push, link, buddy)
  const now = Date.now()
  const today = todayIn(TZ, now)
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now))
  store.change('gavin', (doc) => { doc.profile.waReminders = true; return null })
  store.addTask('gavin', { title: 'Read Books', due: today, time: hm, remind: 0, wa: { before: 0 }, repeat: { freq: 'day', interval: 1 } })
  store.addTask('gavin', { title: 'Bell only', due: today, time: hm, remind: 0 })
  await buddy.tick(now + 1000); await rem.tick(now + 1000)
  await buddy.tick(now + 31000); await rem.tick(now + 31000)
  const wa = sent.filter((x) => x.ep === 'send')
  assert.equal(wa.filter((m) => m.text.includes('Read Books')).length, 1, wa.map((m) => m.text).join('\n---\n'))
  assert.equal(wa.filter((m) => m.text.includes('Bell only')).length, 1) // no "WhatsApp me": the bell still comes to WhatsApp
  assert.equal(pushed.filter((n) => n.title.includes('Read Books')).length, 1) // and the bell still rings on the phone/browser
})

// ---------------------------------------------------------- the new Buddy
const texts = (items) => items.filter((x) => x.text).map((x) => x.text).join('\n---\n')
const menuIn = (items) => items.find((x) => x.menu)?.menu
/** Send items (so menus get their poll ids) and return the sent menu's id and options. */
async function sendMenu(buddy, sent, items, u = 'gavin') {
  await buddy.deliver(u, items)
  const polls = sent.filter((x) => x.ep === 'poll')
  const last = polls.at(-1)
  return { id: `msg-${sent.lastIndexOf(last) + 1}`, options: last.options, name: last.name }
}

test('commands are read strictly, Discord style; "td" still works; notes in your own chat are left alone', () => {
  const p = (t, chat) => { const r = parseCommand(t, chat); return r?.cmd ? `${r.cmd.name}|${r.args}` : r?.unknown ? `?${r.unknown}` : null }
  assert.equal(p('done', 'bot'), 'done|')
  assert.equal(p('Done!', 'bot'), 'done|')
  assert.equal(p('/done K7', 'bot'), 'done|K7')
  assert.equal(p('done K7', 'self'), null) // a note in your own chat
  assert.equal(p('/done K7', 'self'), 'done|K7')
  assert.equal(p('td done 2', 'self'), 'done|2')
  assert.equal(p('td?', 'self'), 'today|')
  assert.equal(p('td: buy milk 5pm', 'self'), 'add|buy milk 5pm')
  assert.equal(p('/dne', 'bot'), '?dne')
  assert.equal(p('/', 'self'), 'menu|')
  assert.equal(p('buy milk tomorrow', 'bot'), null) // not a command: not guessed at
  assert.equal(p('remind me to call mum 8pm', 'bot'), 'add|me to call mum 8pm')
  assert.equal(p('tick 2', 'bot'), 'topic|2') // the old study "tick" keeps its meaning
})

test('task codes: short, no look-alikes, the same every time', () => {
  const { store, buddy } = setup()
  const t = store.addTask('gavin', { title: 'Read' })
  const c = buddy.codeOf('gavin', t)
  assert.match(c, CODE_RE)
  assert.ok(!/[ILO01]/.test(c))
  assert.equal(buddy.codeOf('gavin', t), c)
  assert.equal(buddy.taskOfCode('gavin', c.toLowerCase()).id, t.id)
  assert.equal(buddy.taskOfCode('gavin', 'Z9'), null)
})

test('/add, then commands with a code or with none (the task I just wrote about); usage when it doesn’t fit', async () => {
  const { store, buddy } = setup()
  const now = zonedTime(todayIn(TZ), '10:00', TZ)
  let r = await buddy.run('gavin', 'add buy milk tomorrow 5pm', { now })
  const t = store.snapshot('gavin').tasks.find((x) => x.title === 'buy milk')
  const code = buddy.codeOf('gavin', t)
  assert.match(texts(r), new RegExp(`Added: \\*buy milk\\* · ${code}`))
  assert.match(texts(r), /I’ll WhatsApp you at 5:00 PM/)
  assert.deepEqual([t.time, t.wa], ['17:00', { before: 0 }])
  assert.ok(menuIn(r).options.includes('🗑 Undo (remove it)'))
  // no code: the one I just wrote about
  r = await buddy.run('gavin', 'move 6pm', { now })
  assert.match(texts(r), /Moved \*buy milk\* to tomorrow, 6:00 PM/)
  r = await buddy.run('gavin', `/snooze ${code} 30m`, { now })
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === t.id).wa.at, now + 30 * 60e3)
  r = await buddy.run('gavin', `/move ${code} purple`, { now })
  assert.match(texts(r), /can’t read “purple”[\s\S]*Usage: `\/move \[code\] <day and\/or time>`[\s\S]*Example: `\/move K7 fri 3pm`/)
  r = await buddy.run('gavin', `/rename ${code} buy oat milk`, { now })
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === t.id).title, 'buy oat milk')
  r = await buddy.run('gavin', '/done Z9', { now })
  assert.match(texts(r), /There’s no task \*Z9\*/)
  r = await buddy.run('gavin', `done ${code}`, { now })
  assert.match(texts(r), /Done: \*buy oat milk\*|buy oat milk\* ticked off/)
  // much later, with nothing to go on: it asks which, with a menu (it never guesses)
  store.addTask('gavin', { title: 'Another one' })
  r = await buddy.run('gavin', 'done', { now: now + 3 * 3600e3 })
  assert.equal(menuIn(r)?.meta.kind, 'pick')
})

test('unknown things: a “/word” gets a suggestion; a sentence gets the menu with “add it”; thanks gets a reply; notes in your own chat get nothing', async () => {
  const { buddy } = setup()
  let r = await buddy.run('gavin', '/dne')
  assert.match(texts(r), /don’t know \*\/dne\*\. Did you mean \*\/done\*/)
  r = await buddy.run('gavin', 'finished the bio homework', { chat: 'bot' })
  assert.match(texts(r), /I only understand commands and taps/)
  assert.equal(menuIn(r).options[0], '➕ Add “finished the bio homework” as a task')
  r = await buddy.run('gavin', 'another thing', { chat: 'bot' })
  assert.equal(menuIn(r), undefined, 'not a menu every time')
  assert.match(texts(await buddy.run('gavin', 'thanks!', { chat: 'bot' })), /Anytime|You got it|No problem|Happy to help/)
  assert.deepEqual(await buddy.run('gavin', 'ok', { chat: 'bot' }), []) // no message id to react to: nothing
  assert.deepEqual(await buddy.run('gavin', 'buy eggs', { chat: 'self' }), [])
})

test('tap menus: a list → open a task → done; snooze and move menus; a typed time; delete asks first; undo', async () => {
  const { store, buddy, sent } = setup()
  const today = todayIn(TZ)
  const now = zonedTime(today, '10:00', TZ)
  const a = store.addTask('gavin', { title: 'Lab report', due: today, time: '16:00', wa: { before: 0 } })
  store.addTask('gavin', { title: 'Water plants', due: today })
  const list = await buddy.run('gavin', 'today', { now })
  assert.match(texts(list), new RegExp(`Lab report · 4:00 PM · ${buddy.codeOf('gavin', a)}`))
  let m = await sendMenu(buddy, sent, list)
  const open = m.options.find((o) => o.includes('Lab report'))
  let r = await buddy.tap('gavin', m.id, [open], { now })
  assert.match(texts(r), /📝 \*Lab report\*/)
  m = await sendMenu(buddy, sent, r)
  assert.ok(m.options.length <= 12 && m.options.every((o) => o.length <= 30), `short options for iPhone (${m.options})`)
  // snooze until… → in 15 minutes
  r = await buddy.tap('gavin', m.id, ['⏰ Snooze until…'], { now })
  const sm = await sendMenu(buddy, sent, r)
  r = await buddy.tap('gavin', sm.id, ['In 15 minutes'], { now })
  assert.match(texts(r), /Back at 10:15 AM|again at 10:15 AM/)
  // move… → type a day or time → "fri 3pm"
  r = await buddy.tap('gavin', m.id, ['📅 Move…'], { now: now + 1000 })
  const mm = await sendMenu(buddy, sent, r)
  assert.ok(mm.options.includes('Tomorrow 4:00 PM') && mm.options.includes('⌨️ Type a day or time…'))
  r = await buddy.tap('gavin', mm.id, ['⌨️ Type a day or time…'], { now })
  assert.match(texts(r), /To when\?/)
  r = await buddy.run('gavin', 'purple', { now })
  assert.match(texts(r), /can’t read “purple”/)
  r = await buddy.run('gavin', 'tomorrow', { now }) // while it waits, a plain word is the answer, not the /tomorrow list
  assert.match(texts(r), /Moved \*Lab report\* to tomorrow, 4:00 PM/)
  // done, from the same menu
  r = await buddy.tap('gavin', m.id, ['✅ Done'], { now: now + 2000 })
  assert.match(texts(r), /Lab report/)
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === a.id).done, true)
  // the same tap reported twice counts once
  assert.deepEqual(await buddy.tap('gavin', m.id, ['✅ Done'], { now: now + 3000 }), [])
  // delete asks first; "No" keeps it, "Yes" deletes; /undo brings it back
  const w = store.snapshot('gavin').tasks.find((x) => x.title === 'Water plants')
  r = await buddy.run('gavin', `delete ${buddy.codeOf('gavin', w)}`, { now })
  const dm = await sendMenu(buddy, sent, r)
  assert.deepEqual(dm.options, ['🗑 Yes, delete it', '↩️ No, keep it'])
  await buddy.tap('gavin', dm.id, ['↩️ No, keep it'], { now })
  assert.ok(store.snapshot('gavin').tasks.some((x) => x.id === w.id))
  await buddy.tap('gavin', dm.id, ['🗑 Yes, delete it'], { now })
  assert.ok(!store.snapshot('gavin').tasks.some((x) => x.id === w.id))
  r = await buddy.run('gavin', 'undo', { now })
  assert.match(texts(r), /Water plants\* is back/)
  // a menu that isn't Buddy's, or a week old, does nothing
  assert.deepEqual(await buddy.tap('gavin', 'not-a-menu', ['✅ Done'], { now }), [])
  assert.deepEqual(await buddy.tap('gavin', m.id, ['📅 Move…'], { now: now + 8 * 864e5 }), [])
})

test('replies and 👍: the message you reply to (or react to) says which task', async () => {
  const { store, buddy, sent } = setup()
  const today = todayIn(TZ)
  const now = zonedTime(today, '10:00', TZ)
  const a = store.addTask('gavin', { title: 'Makan Vitamin', due: today, time: '09:00' })
  const b = store.addTask('gavin', { title: 'collect screen protector', due: today, time: '12:00' })
  await buddy.sendTask('gavin', a, { now })
  const cardA = `msg-${sent.findIndex((x) => /Makan Vitamin/.test(x.text || '')) + 1}`
  await buddy.sendTask('gavin', b, { now }) // the newest is the screen protector
  let r = await buddy.run('gavin', 'done', { quote: { id: cardA }, now })
  assert.match(texts(r), /Makan Vitamin/)
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === b.id).done, false)
  // a message Buddy never recorded: the code in the quoted text
  r = await buddy.run('gavin', 'move 6pm', { quote: { id: 'old-one', text: `📝 *collect screen protector* · ${buddy.codeOf('gavin', b)}` }, now })
  assert.match(texts(r), /collect screen protector\* to today, 6:00 PM/)
  // 👍 on its card ticks it off; 👍 on a list does nothing
  const cardB = `msg-${sent.findIndex((x) => /collect screen protector/.test(x.text || '')) + 1}`
  r = buddy.react('gavin', cardB, '👍', { now })
  assert.match(texts(r), /collect screen protector/)
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === b.id).done, true)
  assert.deepEqual(buddy.react('gavin', cardB, '😂', { now }), [])
})

test('repeats keep messaging: done → the next one goes off; a snooze doesn’t stick; old broken copies get fixed', async () => {
  const { store, buddy, sent } = setup()
  const today = todayIn(TZ)
  const t = store.addTask('gavin', { title: 'Makan Pome', due: today, time: '18:00', repeat: { freq: 'day', interval: 1 }, wa: { before: 0 } })
  await buddy.run('gavin', `snooze ${buddy.codeOf('gavin', t)} 1h`)
  assert.deepEqual(store.snapshot('gavin').tasks.find((x) => x.id === t.id).wa.base, { before: 0 })
  const r = await buddy.run('gavin', `done ${buddy.codeOf('gavin', t)}`)
  assert.match(texts(r), /🔁 Next one: Tomorrow, 6:00 PM · [A-Z]\d/)
  const next = store.snapshot('gavin').tasks.find((x) => !x.done && x.title === 'Makan Pome')
  assert.deepEqual(next.wa, { before: 0 }, 'the next one is back to “at due time”, not sent')
  await buddy.tick(zonedTime(next.due, '18:00', TZ) + 60e3)
  assert.ok(sent.some((x) => /Makan Pome/.test(x.text || '')), 'tomorrow’s one goes out')
  assert.ok(sent.some((x) => x.ep === 'poll' && /Makan Pome/.test(x.name)), '…with its menu')
  const y = zonedTime(today, '18:00', TZ) - 864e5
  const old = store.addTask('gavin', { title: 'Old copy', due: today, time: '18:00', repeat: { freq: 'day', interval: 1 } })
  store.change('gavin', (doc) => { const o = doc.tasks.find((x) => x.id === old.id); o.wa = { at: y, sent: `at:${y}` }; o.createdAt = y + 3600e3; return o })
  await buddy.tick(Date.now())
  const fixed = store.snapshot('gavin').tasks.find((x) => x.id === old.id).wa
  assert.deepEqual(fixed, { before: 0 }, 'back to its own time')
})

test('clear reminders cancels task reminders and asks WhatsApp to remove Buddy’s reminder messages', async () => {
  const { store, buddy, sent } = setup()
  const t = store.addTask('gavin', { title: 'Call', wa: { at: Date.now() - 1000 } })
  await buddy.tick()
  const r = await buddy.run('gavin', 'clear reminders')
  assert.match(texts(r), /Cleared 1 WhatsApp reminder/)
  await new Promise((res) => setTimeout(res, 20))
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === t.id).wa, null)
  assert.ok(sent.some((x) => x.ep === 'delete-message'))
})

test('the AI (if the admin set one up) proposes; you confirm with a tap. Lists just run. Bad or no answers fall back.', async () => {
  const { store, buddy, sent } = setup()
  const today = todayIn(TZ)
  const now = zonedTime(today, '10:00', TZ)
  const m = store.addTask('gavin', { title: 'Maths worksheet', due: today })
  const code = buddy.codeOf('gavin', m)
  let answer = `/move ${code} fri 3pm`, seen = null
  buddy.aiConfig = () => ({ key: 'gsk_test', model: 'x' })
  buddy.propose = async (q) => { seen = q; if (answer instanceof Error) throw answer; return answer }
  let r = await buddy.run('gavin', 'push maths to friday 3pm', { now })
  assert.ok(seen.tasks.includes(`${code} · Maths worksheet · Today`), 'it sees codes, titles and when')
  const mm = await sendMenu(buddy, sent, r)
  assert.match(mm.name, /^Move “Maths worksheet” to \w{3} \d+ \w{3}, 3:00 PM\?$/)
  assert.equal(store.snapshot('gavin').tasks.find((x) => x.id === m.id).time, null, 'nothing changes before you confirm')
  r = await buddy.tap('gavin', mm.id, ['✅ Yes, do it'], { now })
  assert.match(texts(r), /Moved \*Maths worksheet\* to \w{3} \d+ \w{3}, 3:00 PM/)
  answer = '/today'
  r = await buddy.run('gavin', 'what do i have today', { now })
  assert.match(texts(r), /📋 \*Today\*/)
  answer = '/done Q9' // a code that doesn't exist
  r = await buddy.run('gavin', 'done with physics', { now })
  assert.match(texts(r), /didn’t get that one/)
  answer = new Error('daily limit reached')
  r = await buddy.run('gavin', 'blah blah', { now: now + 5 * 60e3 })
  assert.match(texts(r), /didn’t get that one/)
  buddy.aiConfig = () => null
})

test('small talk and typed answers, like a person', async () => {
  const { smallTalk } = await import('./buddy.js')
  assert.equal(smallTalk('aight bet thanks'), 'thanks')
  assert.equal(smallTalk('thank you so much!!'), 'thanks')
  assert.equal(smallTalk('ok cool'), 'ack')
  assert.equal(smallTalk('👍'), 'ack')
  assert.equal(smallTalk('no'), null)
  assert.equal(smallTalk('ok move maths to friday'), null)
  assert.equal(smallTalk('is there anything tomorrow'), null)
  const { store, buddy, sent } = setup()
  const today = todayIn(TZ)
  const now = zonedTime(today, '10:00', TZ)
  const m = store.addTask('gavin', { title: 'Maths worksheet', due: today })
  let r = await buddy.run('gavin', 'delete ' + buddy.codeOf('gavin', m), { now })
  await sendMenu(buddy, sent, r)
  r = await buddy.run('gavin', 'yes', { now: now + 60e3 })
  assert.match(texts(r), /Deleted \*Maths worksheet\*/)
  r = await buddy.run('gavin', 'yes', { now: now + 2 * 60e3 }) // already answered: not a second delete
  assert.doesNotMatch(texts(r), /Deleted/)
  r = await buddy.run('gavin', 'thanks!', { now })
  assert.match(texts(r), /Anytime|You got it|No problem|Happy to help/)
  r = await buddy.run('gavin', 'ok', { now, id: 'M1' })
  assert.deepEqual(r, [{ react: '👍', to: 'M1' }])
})
