import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuickAdd, cleanUrl } from './quickadd.js'

const lists = [{ id: 's', name: 'School', emoji: '📚' }]
const T = '2026-09-27' // a Sunday

test('dates, times, priority, tags, list', () => {
  const p = parseQuickAdd('Maths homework tomorrow 4pm !3 #exam @School', lists, T)
  assert.deepEqual([p.title, p.due, p.time, p.priority, p.tags, p.listId], ['Maths homework', '2026-09-28', '16:00', 3, ['exam'], 's'])
  assert.equal(parseQuickAdd('Call mum fri', lists, T).due, '2026-10-02')
  assert.equal(parseQuickAdd('Party 25 dec', lists, T).due, '2026-12-25')
  assert.equal(parseQuickAdd('Old 1 jan', lists, T).due, '2027-01-01')
  assert.equal(parseQuickAdd('Dinner tonight', lists, T).time, '20:00')
})

test('repeats', () => {
  const p = parseQuickAdd('Gym every mon and thu 6pm', lists, T)
  assert.deepEqual(p.repeat, { freq: 'week', interval: 1, weekdays: [1, 4] })
  assert.equal(p.due, '2026-09-28')
  assert.deepEqual(parseQuickAdd('Report every 2 weeks', lists, T).repeat, { freq: 'week', interval: 2 })
})

test('links', () => {
  const p = parseQuickAdd('Read this https://example.com/a?b=1. later', lists, T)
  assert.equal(p.title, 'Read this later')
  assert.deepEqual(p.links, [{ url: 'https://example.com/a?b=1', title: '' }])
  assert.equal(cleanUrl('javascript:alert(1)'), null)
  assert.equal(cleanUrl('data:text/html,hi'), null)
  assert.equal(cleanUrl('example.com/x'), 'https://example.com/x')
  assert.equal(cleanUrl('https://nohost'), null)
})

test('how long: "for 1h", "for 30 min", "for 1.5 hours", "for 1h30", "for an hour"; not "for mum"', () => {
  const p = (s) => parseQuickAdd(s, [], '2026-10-15')
  assert.equal(p('Gym for 1h tomorrow 6pm').duration, 60)
  assert.equal(p('Gym for 1h tomorrow 6pm').title, 'Gym')
  assert.equal(p('Read for 30 min').duration, 30)
  assert.equal(p('Essay for 1.5 hours').duration, 90)
  assert.equal(p('Study for 1h30 tonight').duration, 90)
  assert.equal(p('Call grandma for an hour').duration, 60)
  assert.equal(p('Buy a gift for mum').duration, undefined)
  assert.equal(p('Buy a gift for mum').title, 'Buy a gift for mum')
  assert.equal(p('Nap for 2 min').duration, undefined, 'too short: stays in the title')
})

test('joining words left over at the ends of the title go', () => {
  const p = parseQuickAdd('12 AM today to charge powerbank', lists, T)
  assert.equal(p.title, 'charge powerbank')
  assert.equal(parseQuickAdd('submit essay by 5pm', lists, T).title, 'submit essay')
  assert.equal(parseQuickAdd('tomorrow I need to call mum', lists, T).title, 'call mum')
  assert.equal(parseQuickAdd('remind me to drink water at 3pm', lists, T).title, 'drink water')
  assert.equal(parseQuickAdd('jangan lupa bayar listrik besok jam 7pm', lists, T).title, 'bayar listrik besok')
  assert.equal(parseQuickAdd('Tomato soup 6pm', lists, T).title, 'Tomato soup') // "to" inside a word stays
  assert.equal(parseQuickAdd('Go to the bank fri', lists, T).title, 'Go to the bank') // "to" in the middle stays
  assert.equal(parseQuickAdd('to', lists, T).title, 'to') // nothing else left: keep it
})

test('"12 AM today" and "midnight" mean the midnight coming up', () => {
  const p = parseQuickAdd('12 AM today to charge powerbank', lists, T)
  assert.deepEqual([p.due, p.time], ['2026-09-28', '00:00'])
  assert.deepEqual(['due', 'time'].map((k) => parseQuickAdd('charge phone midnight', lists, T)[k]), ['2026-09-28', '00:00'])
  assert.deepEqual(['due', 'time'].map((k) => parseQuickAdd('charge phone 12am', lists, T)[k]), ['2026-09-28', '00:00'])
  assert.deepEqual(['due', 'time'].map((k) => parseQuickAdd('flight 12am fri', lists, T)[k]), ['2026-10-02', '00:00']) // another day: as written
  assert.deepEqual(['due', 'time'].map((k) => parseQuickAdd('call 12:30am today', lists, T)[k]), ['2026-09-27', '00:30']) // only exactly midnight moves
})
