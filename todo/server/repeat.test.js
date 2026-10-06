// node --test server/
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRepeat, nextOccurrence, occurrencesBetween, describeRepeat } from './repeat.js'

test('daily and every n days', () => {
  assert.equal(nextOccurrence('2026-09-30', { freq: 'day', interval: 1 }), '2026-10-01')
  assert.equal(nextOccurrence('2026-12-30', { freq: 'day', interval: 3 }), '2027-01-02')
})

test('weekly, plain and on chosen weekdays', () => {
  assert.equal(nextOccurrence('2026-09-25', { freq: 'week', interval: 1 }), '2026-10-02')
  // 2026-09-28 is a Monday; Mon+Thu every 2 weeks
  const r = { freq: 'week', interval: 2, weekdays: [1, 4] }
  assert.equal(nextOccurrence('2026-09-28', r), '2026-10-01') // Mon → Thu same week
  assert.equal(nextOccurrence('2026-10-01', r), '2026-10-12') // Thu → Mon two weeks on
  assert.equal(nextOccurrence('2026-09-27', { freq: 'week', interval: 1, weekdays: [0] }), '2026-10-04') // Sun → Sun
})

test('monthly clamps to short months', () => {
  const r = { freq: 'month', interval: 1 }
  assert.equal(nextOccurrence('2027-01-31', r), '2027-02-28')
  assert.equal(nextOccurrence('2028-01-31', r), '2028-02-29')
  assert.equal(nextOccurrence('2026-11-15', { freq: 'month', interval: 3 }), '2027-02-15')
})

test('yearly on 29 Feb', () => {
  assert.equal(nextOccurrence('2028-02-29', { freq: 'year', interval: 1 }), '2029-02-28')
})

test('until stops the series', () => {
  assert.equal(nextOccurrence('2026-09-30', { freq: 'day', interval: 1, until: '2026-09-30' }), null)
  assert.deepEqual(occurrencesBetween('2026-09-28', { freq: 'day', interval: 1, until: '2026-10-01' }, '2026-09-01', '2026-10-31'), ['2026-09-29', '2026-09-30', '2026-10-01'])
})

test('validation and descriptions', () => {
  assert.equal(cleanRepeat(null), null)
  assert.deepEqual(cleanRepeat({ freq: 'week', interval: '2', weekdays: [4, 1, 1, 9] }), { freq: 'week', interval: 2, weekdays: [1, 4] })
  assert.throws(() => cleanRepeat({ freq: 'hourly' }))
  assert.throws(() => cleanRepeat({ freq: 'day', interval: 0 }))
  assert.equal(describeRepeat({ freq: 'day', interval: 1 }), 'Daily')
  assert.equal(describeRepeat({ freq: 'week', interval: 2, weekdays: [1, 4] }), 'Every 2 weeks on Mon, Thu')
  assert.equal(describeRepeat({ freq: 'week', interval: 1, weekdays: [1, 3, 5] }), 'Every Mon, Wed, Fri')
})
