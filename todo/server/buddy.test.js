import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store.js'
import { Buddy, snoozeUntil, waInstant, waSig } from './buddy.js'
import { zonedTime, todayIn } from './tz.js'

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
      if (ep === 'send') return { ok: true, id: `msg-${sent.length}`, jid: p.jid || '6591234567@s.whatsapp.net' }
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

test('replies: done, start, step, snooze, numbered lists, move, remind me', () => {
  const { store, buddy, changed } = setup()
  const today = todayIn(TZ)
  const a = store.addTask('gavin', { title: 'Lab report', due: today, subtasks: [{ title: 'Graphs' }, { title: 'Conclusion' }] })
  const b = store.addTask('gavin', { title: 'Water plants', due: today, repeat: { freq: 'day', interval: 1 } })
  assert.match(buddy.command('gavin', 'done').reply, /Which one/)
  assert.match(buddy.command('gavin', '?').reply, /1\. .*Lab report[\s\S]*2\. .*Water plants/)
  assert.match(buddy.command('gavin', 'step 1').reply, /Ticked: _Graphs_/)
  assert.match(buddy.command('gavin', 'start 1').reply, /Lab report/)
  assert.equal(store.snapshot('gavin').tasks.find((t) => t.id === a.id).status, 'doing')
  assert.match(buddy.command('gavin', 'done 2').reply, /Next one/) // a repeat says when the next one is
  assert.match(buddy.command('gavin', 'snooze 1 2h').reply, /Lab report/)
  assert.ok(store.snapshot('gavin').tasks.find((t) => t.id === a.id).wa.at > Date.now() + 1.9 * 3600e3)
  assert.match(buddy.command('gavin', 'snooze 1 someday').reply, /didn’t get when/)
  assert.match(buddy.command('gavin', 'move').reply, /Moved 1 task/)
  assert.ok(store.snapshot('gavin').tasks.find((t) => t.id === a.id).due > today)
  const r = buddy.command('gavin', 'remind me to call mum tomorrow 8pm')
  assert.equal(r.task.title, 'call mum')
  assert.deepEqual(r.task.wa, { before: 0 })
  assert.equal(r.task.remind, 0)
  assert.equal(buddy.command('gavin', 'buy milk tomorrow'), null) // not a command: an ordinary "add a task"
  assert.equal(buddy.command('gavin', 'done laundry'), null)
  assert.ok(changed.length >= 4)
  assert.ok(b) // (water plants was finished above)
})

test('clear reminders cancels task reminders and asks WhatsApp to remove Buddy reminder text', async () => {
  const { store, buddy, sent } = setup()
  store.addTask('gavin', { title: 'Reminder task', wa: { at: Date.now() + 3600e3 } })
  await buddy.send('gavin', '⏰ *Reminder task*', { kind: 'reminder' })
  await buddy.send('gavin', 'A normal Buddy message', { kind: 'morning' })
  const r = buddy.command('gavin', 'clear reminders')
  assert.match(r.reply, /Cleared 1 reminder/)
  assert.equal(store.snapshot('gavin').tasks[0].wa, null)
  await new Promise((resolve) => setImmediate(resolve))
  const deletes = sent.filter((x) => x.ep === 'delete-message')
  assert.equal(deletes.length, 1)
})

test('convenience commands add, tomorrow and delete work on the same numbered-list target', () => {
  const { store, buddy } = setup()
  const today = todayIn(TZ)
  const r = buddy.command('gavin', 'add buy milk tomorrow 5pm !3 #groceries')
  assert.equal(r.task.title, 'buy milk')
  assert.equal(r.task.priority, 3)
  assert.equal(buddy.command('gavin', 'tomorrow').reply.includes('buy milk'), true)
  assert.match(buddy.command('gavin', 'delete 1').reply, /Removed \*buy milk\*/)
  assert.equal(store.snapshot('gavin').tasks.some((t) => t.title === 'buy milk'), false)
  assert.ok(today)
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
