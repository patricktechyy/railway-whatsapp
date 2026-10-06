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
