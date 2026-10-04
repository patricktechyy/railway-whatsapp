import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Holidays, parseIcs, countryForTz } from './holidays.js'

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260817',
  'DTEND;VALUE=DATE:20260818',
  'SUMMARY:Independence Day',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260320',
  'DTEND;VALUE=DATE:20260322',
  'SUMMARY:Idul Fitri\\, Day 1 and 2',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261225',
  'DTEND;VALUE=DATE:20261226',
  'SUMMARY:Christmas',
  '  Day',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

test('parses all-day, multi-day, escaped and folded events', () => {
  assert.deepEqual(parseIcs(ICS), [
    { date: '2026-03-20', name: 'Idul Fitri, Day 1 and 2' },
    { date: '2026-03-21', name: 'Idul Fitri, Day 1 and 2' },
    { date: '2026-08-17', name: 'Independence Day' },
    { date: '2026-12-25', name: 'Christmas Day' },
  ])
})

test('fetches, caches, and falls back when the source is down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hol-'))
  let up = true, calls = 0
  const fetcher = async () => { calls++; if (!up) throw new Error('offline'); return { ok: true, text: async () => ICS } }
  const h = new Holidays(dir, { fetcher })
  const a = await h.get('ID', 2026)
  assert.equal(a.source, 'google')
  assert.equal(a.list.length, 4)
  await h.get('ID', 2026)
  assert.equal(calls, 1, 'second call served from cache')
  // stale cache + offline → serves the cache
  const f = h.file('ID'); const d = JSON.parse(fs.readFileSync(f)); d.at = 0; fs.writeFileSync(f, JSON.stringify(d))
  up = false
  assert.equal((await h.get('ID', 2026)).source, 'cache')
  // nothing cached + offline → fixed dates
  const b = await h.get('SG', 2026)
  assert.equal(b.source, 'built-in')
  assert.ok(b.list.some((x) => x.date === '2026-08-09'))
  assert.equal((await h.get('XX', 2026)).list.length, 0)
})

test('country from timezone', () => {
  assert.equal(countryForTz('Asia/Jakarta'), 'ID')
  assert.equal(countryForTz('Australia/Sydney'), 'AU')
  assert.equal(countryForTz('Europe/Paris'), null)
})
