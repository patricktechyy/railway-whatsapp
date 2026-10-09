import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QuickReminders, parseReminder } from './quickremind.js'
import { zonedTime } from './tz.js'

const TZ = 'Asia/Jakarta'
const NOW = zonedTime('2026-10-09', '21:00', TZ)
const MIN = 60000

test('when: lengths of time, clock times, today / tonight / tomorrow', () => {
  assert.deepEqual(parseReminder('30m buy milk', TZ, NOW), { at: NOW + 30 * MIN, text: 'buy milk' })
  assert.equal(parseReminder('1h30m stretch', TZ, NOW).at, NOW + 90 * MIN)
  assert.equal(parseReminder('in 2 hours call mum', TZ, NOW).at, NOW + 120 * MIN)
  assert.equal(parseReminder('3 days return book', TZ, NOW).at, NOW + 3 * 1440 * MIN)
  assert.equal(parseReminder('10pm lights off', TZ, NOW).at, zonedTime('2026-10-09', '22:00', TZ))
  assert.equal(parseReminder('5:30pm bus', TZ, NOW).at, zonedTime('2026-10-10', '17:30', TZ), 'gone today → tomorrow')
  assert.equal(parseReminder('17:30 bus', TZ, NOW).at, zonedTime('2026-10-10', '17:30', TZ))
  assert.equal(parseReminder('tomorrow 8am PE kit', TZ, NOW).at, zonedTime('2026-10-10', '08:00', TZ))
  assert.equal(parseReminder('tomorrow bring PE kit', TZ, NOW).at, zonedTime('2026-10-10', '09:00', TZ))
  assert.equal(parseReminder('at 11pm sleep', TZ, NOW).text, 'sleep')
  assert.equal(parseReminder('30m to drink water', TZ, NOW).text, 'drink water')
})

test('when: what is missing or wrong', () => {
  assert.equal(parseReminder('buy milk', TZ, NOW).error, 'when')
  assert.equal(parseReminder('5 apples', TZ, NOW).error, 'when', 'a bare number is not a time')
  assert.equal(parseReminder('30m', TZ, NOW).error, 'what')
  assert.equal(parseReminder('400 days x', TZ, NOW).error, 'far')
})

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'))
  const sent = []
  const q = new QuickReminders(dir, { tzOf: () => TZ, send: async (m) => { sent.push(m) } })
  return { q, sent, dir }
}

test('set, list, cancel; the reply is its own voice', () => {
  const { q } = setup()
  assert.equal(QuickReminders.wants('-reminder 30m buy milk'), true)
  assert.equal(QuickReminders.wants('- reminders'), true)
  assert.equal(QuickReminders.wants('td remind me to call mum'), false)
  assert.equal(QuickReminders.wants('-5 degrees today'), false)
  assert.equal(q.command('ali', '-reminder 30m buy milk', { via: 'self' }, NOW), '⏰ Okay, today at 9:30 PM (in 30 min): buy milk')
  assert.match(q.command('ali', '-reminder tomorrow 8am PE kit', { via: 'self' }, NOW), /tomorrow at 8:00 AM \(in 11 h\): PE kit/)
  const list = q.command('ali', '-reminders', null, NOW)
  assert.match(list, /1\. buy milk · today at 9:30 PM\n2\. PE kit · tomorrow at 8:00 AM/)
  assert.equal(q.command('ali', '-cancel 1', null, NOW), '🗑️ Cancelled: buy milk')
  assert.equal(q.list('ali').length, 1)
  assert.match(q.command('ali', '-cancel 5', null, NOW), /no number 5/)
  assert.match(q.command('ali', '-reminder', null, NOW), /Quick reminders/)
  assert.match(q.command('ali', '-reminder buy milk', null, NOW), /^When\?/)
})

test('goes off once, in the chat it was set in, and survives a restart', async () => {
  const { q, sent, dir } = setup()
  q.command('ali', '-reminder 30m buy milk', { via: 'bot', jid: '6281@s.whatsapp.net' }, NOW)
  q.command('budi', '-reminder 2h call mum', { via: 'self' }, NOW)
  const again = new QuickReminders(dir, { tzOf: () => TZ, send: async (m) => { sent.push(m) } })
  await again.tick(NOW + 29 * MIN)
  assert.equal(sent.length, 0)
  await again.tick(NOW + 31 * MIN)
  await again.tick(NOW + 32 * MIN)
  assert.deepEqual(sent, [{ user: 'ali', chat: { via: 'bot', jid: '6281@s.whatsapp.net' }, text: '⏰ *Reminder:* buy milk' }])
  assert.equal(again.list('ali').length, 0)
  assert.equal(again.list('budi').length, 1)
})

test('missed by more than 12 hours (server down): dropped quietly', async () => {
  const { q, sent } = setup()
  q.command('ali', '-reminder 30m buy milk', { via: 'self' }, NOW)
  await q.tick(NOW + 13 * 60 * MIN)
  assert.equal(sent.length, 0)
  assert.equal(q.list('ali').length, 0)
})
