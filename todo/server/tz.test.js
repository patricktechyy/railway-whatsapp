import test from 'node:test'
import assert from 'node:assert/strict'
import { zonedTime, offsetMinutes, validTz } from './tz.js'

test('fixed-offset zones', () => {
  assert.equal(new Date(zonedTime('2026-09-27', '09:00', 'Asia/Jakarta')).toISOString(), '2026-09-27T02:00:00.000Z')
  assert.equal(new Date(zonedTime('2026-09-27', '00:30', 'Asia/Singapore')).toISOString(), '2026-09-26T16:30:00.000Z')
  assert.equal(offsetMinutes(Date.UTC(2026, 0, 1), 'Asia/Kolkata'), 330)
})

test('daylight saving', () => {
  // London: BST (+1) in September, GMT in December
  assert.equal(new Date(zonedTime('2026-09-27', '09:00', 'Europe/London')).toISOString(), '2026-09-27T08:00:00.000Z')
  assert.equal(new Date(zonedTime('2026-12-01', '09:00', 'Europe/London')).toISOString(), '2026-12-01T09:00:00.000Z')
  // New York the day DST ends (1 Nov 2026): 9am is EST (-5)
  assert.equal(new Date(zonedTime('2026-11-01', '09:00', 'America/New_York')).toISOString(), '2026-11-01T14:00:00.000Z')
})

test('bad zone falls back to UTC', () => {
  assert.equal(validTz('Not/AZone'), false)
  assert.equal(new Date(zonedTime('2026-09-27', '09:00', 'Not/AZone')).toISOString(), '2026-09-27T09:00:00.000Z')
})
