import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store.js'

const fresh = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')))

test('day notes: add, edit, clear, validate', () => {
  const s = fresh()
  const n = s.setDayNote('zef', '2026-10-05', { label: '  Mum’s birthday 🎂 ', notes: 'Buy cake', color: 'magenta' })
  assert.equal(n.label, 'Mum’s birthday 🎂')
  assert.equal(n.color, 'magenta')
  assert.equal(s.setDayNote('zef', '2026-10-05', { label: 'x'.repeat(99), notes: '', color: 'nope' }).label.length, 40)
  assert.equal(s.snapshot('zef').dayNotes['2026-10-05'].color, 'blue')
  // both texts empty → the note goes away
  assert.equal(s.setDayNote('zef', '2026-10-05', { label: ' ', notes: '' }), null)
  assert.equal(s.snapshot('zef').dayNotes['2026-10-05'], undefined)
  assert.throws(() => s.setDayNote('zef', '5 Oct', { label: 'x' }), /Bad date/)
  s.setDayNote('zef', '2026-10-06', { label: 'x' })
  s.deleteDayNote('zef', '2026-10-06')
  assert.deepEqual(s.snapshot('zef').dayNotes, {})
})

test('profile: holiday country and appearance are validated', () => {
  const s = fresh()
  assert.equal(s.setProfile('zef', { holidayCountry: 'ID' }).holidayCountry, 'ID')
  assert.equal(s.setProfile('zef', { holidayCountry: 'off' }).holidayCountry, 'off')
  assert.throws(() => s.setProfile('zef', { holidayCountry: 'XX' }), /Unknown country/)
  const a = s.setProfile('zef', { appearance: { preset: 'custom', sidebar: '#FF0000', accent: null, button: '#000000', taskBg: null } }).appearance
  assert.equal(a.preset, 'custom')
  assert.equal(a.sidebar.toLowerCase(), '#ff0000')
  assert.throws(() => s.setProfile('zef', { appearance: { preset: 'mono', sidebar: 'red; background:url(x)' } }))
  assert.equal(s.setProfile('zef', { appearance: { preset: 'hacker' } }).appearance.preset, 'discord')
})

test('profile changes tell the person’s other devices', () => {
  const s = fresh()
  const seen = []
  s.bus.on('zef', (e) => seen.push(e.type))
  s.setProfile('zef', { holidayCountry: 'SG' })
  assert.ok(seen.includes('profile'))
})

test('deleting a list: keep or delete its tasks, and undo', () => {
  const s = fresh()
  const l = s.addList('zef', { name: 'Trip', emoji: '✈️', color: 'green' })
  const a = s.addTask('zef', { title: 'Pack', listId: l.id, priority: 2 })
  const b = s.addTask('zef', { title: 'Tickets', listId: l.id, due: '2026-10-01', status: 'done' })
  // keep
  let r = s.deleteList('zef', l.id)
  assert.deepEqual(r.moved.sort(), [a.id, b.id].sort())
  assert.equal(s.snapshot('zef').tasks.find((t) => t.id === a.id).listId, null)
  s.restoreList('zef', r)
  assert.equal(s.snapshot('zef').tasks.find((t) => t.id === a.id).listId, l.id)
  // delete
  r = s.deleteList('zef', l.id, { deleteTasks: true })
  assert.equal(r.tasks.length, 2)
  assert.equal(s.snapshot('zef').tasks.length, 0)
  const back = s.restoreList('zef', JSON.parse(JSON.stringify(r)))
  assert.equal(back.id, l.id)
  const tasks = s.snapshot('zef').tasks
  assert.equal(tasks.length, 2)
  assert.ok(tasks.every((t) => t.listId === l.id))
  assert.equal(tasks.find((t) => t.title === 'Tickets').status, 'done')
  assert.equal(tasks.find((t) => t.title === 'Pack').priority, 2)
})

test('board: default, validation, notes', () => {
  const s = fresh()
  const doc = s.snapshot('zef')
  assert.ok(doc.board.widgets.some((w) => w.type === 'priority'))
  const saved = s.saveBoard('zef', { widgets: [{ id: 'a', type: 'notes', size: 'huge', config: { text: 'hi' } }, { id: 'a', type: 'todo', size: 'lg' }, { type: 'list', config: { listId: 'nope' } }] })
  assert.equal(saved.widgets[0].size, 'md')
  assert.equal(saved.widgets[0].config.text, 'hi')
  assert.notEqual(saved.widgets[1].id, 'a', 'duplicate ids are replaced')
  assert.equal(saved.widgets[2].config.listId, null)
  assert.throws(() => s.saveBoard('zef', { widgets: [{ type: 'hack' }] }), /Unknown/)
  assert.throws(() => s.saveBoard('zef', { widgets: Array.from({ length: 21 }, () => ({ type: 'todo' })) }), /at most 20/)
})

test('tour done is remembered on the account', () => {
  const s = fresh()
  assert.equal(s.setProfile('zef', { tourDone: true }).tourDone, true)
})

test('lists can have any #rrggbb colour', () => {
  const s = fresh()
  const l = s.addList('zef', { name: 'Art', color: '#FF5500' })
  assert.equal(l.color, '#ff5500')
  assert.equal(s.updateList('zef', l.id, { color: 'green' }).color, 'green')
  assert.equal(s.updateList('zef', l.id, { color: '#123abc' }).color, '#123abc')
  assert.throws(() => s.updateList('zef', l.id, { color: 'red; x' }), /Colour/)
  assert.equal(s.addList('zef', { name: 'X', color: 'nope' }).color.length > 0, true)
})

test('board blocks: height, hidden, sticky colour', () => {
  const s = fresh()
  const b = s.saveBoard('zef', { widgets: [
    { type: 'notes', h: 300, config: { text: 'a', color: 'pink' } },
    { type: 'notes', h: 5, hidden: true, config: { color: 'tartan' } },
    { type: 'todo', h: 'tall' },
  ] })
  assert.equal(b.widgets[0].h, 300)
  assert.equal(b.widgets[0].config.color, 'pink')
  assert.equal(b.widgets[1].h, null)
  assert.equal(b.widgets[1].hidden, true)
  assert.equal(b.widgets[1].config.color, 'yellow')
  assert.equal(b.widgets[2].h, null)
  assert.equal(b.widgets[2].hidden, false)
})

test('appearance keeps a saved Custom set', () => {
  const s = fresh()
  const a = s.setProfile('zef', { appearance: { preset: 'discord', custom: { base: 'mono', page: '#FAFAF0', card: null, text: '#111111' } } }).appearance
  assert.equal(a.preset, 'discord')
  assert.deepEqual([a.custom.base, a.custom.page, a.custom.text, a.custom.card], ['mono', '#fafaf0', '#111111', null])
  assert.throws(() => s.setProfile('zef', { appearance: { preset: 'custom', custom: { page: 'url(x)' } } }), /page/)
})

test('board widths on a 12-column grid', () => {
  const s = fresh()
  const b = s.saveBoard('zef', { widgets: [{ type: 'todo', size: 'lg' }, { type: 'todo', w: 6 }, { type: 'todo', w: 2, size: 'sm' }, { type: 'todo', w: 7.5 }] })
  assert.deepEqual(b.widgets.map((w) => w.w), [12, 6, 4, 8])
  assert.deepEqual(b.widgets.map((w) => w.size), ['lg', 'md', 'sm', 'md'])
})

test('Personalize It gradient is validated', () => {
  const s = fresh()
  const a = s.setProfile('zef', { appearance: { preset: 'discord', personalize: { from: '#FF0080', to: '#7928CA', angle: -45 } } }).appearance
  assert.deepEqual(a.personalize, { from: '#ff0080', to: '#7928ca', angle: 315 })
  assert.throws(() => s.setProfile('zef', { appearance: { preset: 'discord', personalize: { from: 'red', to: '#000000' } } }), /gradient/)
  assert.equal(s.setProfile('zef', { appearance: { preset: 'discord' } }).appearance.personalize, null)
})

test('a repeat’s WhatsApp message comes with it to the next date, unsent', async () => {
  const { waForNext } = await import('./store.js')
  const { zonedTime } = await import('./tz.js')
  const tz = 'Asia/Singapore'
  // "at due time" and "1 hour before": carried over as they are, not "sent"
  assert.deepEqual(waForNext({ before: 0, sent: 'b:2026-10-13|18:00|0' }, '2026-10-13', '2026-10-14', tz), { before: 0 })
  assert.deepEqual(waForNext({ before: 60 }, '2026-10-13', '2026-10-20', tz), { before: 60 })
  // a one-off time picked for that day (6:43 PM) doesn't stick: back to the task's own time
  const at = zonedTime('2026-10-13', '18:43', tz)
  assert.deepEqual(waForNext({ at, sent: `at:${at}` }, '2026-10-13', '2026-10-14', tz), { before: 0 })
  // snoozed: back to what it was before the snooze
  assert.deepEqual(waForNext({ at: at + 7200e3, base: { before: 0 }, sent: 'x' }, '2026-10-13', '2026-10-14', tz), { before: 0 })
})

test('how long a task takes: optional, checked, and the calendar event is that long', async () => {
  const { CalendarFeeds } = await import('./calendar.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dur-'))
  const store = new Store(dir)
  const a = store.addTask('gavin', { title: 'Gym', due: '2026-10-16', time: '18:00', duration: 90 })
  const b = store.addTask('gavin', { title: 'Call', due: '2026-10-16', time: '09:00' })
  const c = store.addTask('gavin', { title: 'Essay', due: '2026-10-16', duration: 120 })
  assert.equal(a.duration, 90)
  assert.equal(b.duration, null, 'not set by default')
  assert.throws(() => store.addTask('gavin', { title: 'x', duration: 2 }), /5 minutes and 24 hours/)
  assert.equal(store.updateTask('gavin', b.id, { duration: 45 }).duration, 45)
  assert.equal(store.updateTask('gavin', b.id, { duration: null }).duration, null)
  const ics = new CalendarFeeds(dir).ics({ name: 'T', tz: 'Asia/Singapore', host: 'x', items: [a, b, c].map((task) => ({ task })) })
  const ev = (title) => ics.split('BEGIN:VEVENT').find((e) => e.includes(`SUMMARY:${title}`))
  assert.match(ev('Gym'), /DTSTART:20261016T100000Z[\s\S]*DTEND:20261016T113000Z/, 'Gym: 6 PM to 7:30 PM (SGT)')
  assert.match(ev('Call'), /DTSTART:20261016T010000Z[\s\S]*DTEND:20261016T013000Z/, 'no length set: 30 minutes')
  assert.match(ev('Essay'), /VALUE=DATE[\s\S]*DESCRIPTION:Takes about 2 h/, 'no time: all day, says how long')
  // a repeat keeps its length
  const r = store.addTask('gavin', { title: 'Run', due: '2026-10-16', time: '07:00', duration: 30, repeat: { freq: 'day', interval: 1 } })
  store.updateTask('gavin', r.id, { status: 'done' })
  assert.equal(store.snapshot('gavin').tasks.find((t) => t.title === 'Run' && !t.done).duration, 30)
})
