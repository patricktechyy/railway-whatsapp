import fs from 'node:fs'
import path from 'node:path'

/**
 * National & public holidays, from Google's public holiday calendars (the
 * same ones Google Calendar offers; no API key needed). Each country's list
 * is cached on the volume for a day; if Google can't be reached we serve the
 * last copy, or at least the fixed-date holidays below.
 */

export const COUNTRIES = {
  ID: { name: 'Indonesia', cal: 'en.indonesian' },
  SG: { name: 'Singapore', cal: 'en.singapore' },
  MY: { name: 'Malaysia', cal: 'en.malaysia' },
  PH: { name: 'Philippines', cal: 'en.philippines' },
  AU: { name: 'Australia', cal: 'en.australian' },
  GB: { name: 'United Kingdom', cal: 'en.uk' },
  US: { name: 'United States', cal: 'en.usa' },
  JP: { name: 'Japan', cal: 'en.japanese' },
  CN: { name: 'China', cal: 'en.china' },
  IN: { name: 'India', cal: 'en.indian' },
  HK: { name: 'Hong Kong', cal: 'en.hong_kong' },
}

/** A best guess from someone's timezone, so most people never have to pick. */
const TZ_COUNTRY = {
  'Asia/Jakarta': 'ID', 'Asia/Makassar': 'ID', 'Asia/Jayapura': 'ID', 'Asia/Pontianak': 'ID',
  'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Kuching': 'MY', 'Asia/Manila': 'PH',
  'Europe/London': 'GB', 'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN', 'Asia/Kolkata': 'IN', 'Asia/Hong_Kong': 'HK',
}
export const countryForTz = (tz) => TZ_COUNTRY[tz] || (/^Australia\//.test(tz || '') ? 'AU' : /^America\//.test(tz || '') ? 'US' : null)

// Fixed-date holidays, used only when the real list can't be fetched.
const FIXED = {
  ID: [['01-01', "New Year's Day"], ['05-01', 'Labour Day'], ['06-01', 'Pancasila Day'], ['08-17', 'Independence Day'], ['12-25', 'Christmas Day']],
  SG: [['01-01', "New Year's Day"], ['05-01', 'Labour Day'], ['08-09', 'National Day'], ['12-25', 'Christmas Day']],
  MY: [['01-01', "New Year's Day"], ['05-01', 'Labour Day'], ['08-31', 'National Day'], ['09-16', 'Malaysia Day'], ['12-25', 'Christmas Day']],
  PH: [['01-01', "New Year's Day"], ['06-12', 'Independence Day'], ['12-25', 'Christmas Day'], ['12-30', 'Rizal Day']],
  AU: [['01-01', "New Year's Day"], ['01-26', 'Australia Day'], ['04-25', 'Anzac Day'], ['12-25', 'Christmas Day'], ['12-26', 'Boxing Day']],
  GB: [['01-01', "New Year's Day"], ['12-25', 'Christmas Day'], ['12-26', 'Boxing Day']],
  US: [['01-01', "New Year's Day"], ['06-19', 'Juneteenth'], ['07-04', 'Independence Day'], ['11-11', 'Veterans Day'], ['12-25', 'Christmas Day']],
  JP: [['01-01', "New Year's Day"], ['02-11', 'National Foundation Day'], ['05-03', 'Constitution Day'], ['05-05', "Children's Day"], ['11-03', 'Culture Day']],
  CN: [['01-01', "New Year's Day"], ['05-01', 'Labour Day'], ['10-01', 'National Day']],
  IN: [['01-26', 'Republic Day'], ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti'], ['12-25', 'Christmas Day']],
  HK: [['01-01', "New Year's Day"], ['07-01', 'HKSAR Establishment Day'], ['10-01', 'National Day'], ['12-25', 'Christmas Day']],
}

const DAY = 864e5
const TTL = DAY

/** Undo ICS text escaping and line folding. */
function unfold(ics) {
  return ics.replace(/\r?\n[ \t]/g, '')
}
const unescape = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim()

/** All-day events from an ICS file → [{date: 'YYYY-MM-DD', name}], one per day (multi-day events are expanded). */
export function parseIcs(ics) {
  const out = []
  for (const block of unfold(String(ics || '')).split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0]
    const get = (key) => {
      const m = body.match(new RegExp(`^${key}(?:;[^:\\n]*)?:(.*)$`, 'm'))
      return m ? m[1].trim() : ''
    }
    const start = get('DTSTART').match(/^(\d{4})(\d{2})(\d{2})/)
    const name = unescape(get('SUMMARY'))
    if (!start || !name) continue
    const end = get('DTEND').match(/^(\d{4})(\d{2})(\d{2})/)
    const from = Date.UTC(+start[1], +start[2] - 1, +start[3])
    // DTEND of an all-day event is the day *after* it ends
    const to = end ? Math.max(from, Date.UTC(+end[1], +end[2] - 1, +end[3]) - DAY) : from
    for (let t = from, n = 0; t <= to && n < 14; t += DAY, n++) out.push({ date: new Date(t).toISOString().slice(0, 10), name })
  }
  const seen = new Set()
  return out
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
    .filter((h) => { const k = `${h.date}|${h.name}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export function fixedHolidays(country, year) {
  return (FIXED[country] || []).map(([md, name]) => ({ date: `${year}-${md}`, name }))
}

export class Holidays {
  constructor(dataDir, { fetcher = globalThis.fetch, urlFor } = {}) {
    this.dir = path.join(dataDir, 'holidays')
    fs.mkdirSync(this.dir, { recursive: true })
    this.fetcher = fetcher
    const template = process.env.HOLIDAY_ICS_URL // e.g. for tests: http://localhost:9500/{cal}.ics
    this.urlFor = urlFor || ((cal) => template
      ? template.replace('{cal}', encodeURIComponent(cal))
      : `https://calendar.google.com/calendar/ical/${encodeURIComponent(`${cal}#holiday@group.v.calendar.google.com`)}/public/basic.ics`)
    this.inflight = new Map()
  }

  file(country) {
    return path.join(this.dir, `${country}.json`)
  }

  cached(country) {
    try { return JSON.parse(fs.readFileSync(this.file(country), 'utf8')) } catch { return null }
  }

  async refresh(country) {
    const r = await this.fetcher(this.urlFor(COUNTRIES[country].cal), { signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(`holiday calendar answered ${r.status}`)
    const list = parseIcs(await r.text())
    if (!list.length) throw new Error('holiday calendar was empty')
    const data = { at: Date.now(), list }
    fs.writeFileSync(this.file(country), JSON.stringify(data))
    return data
  }

  /** Holidays for a country in a year (or a range of years). Never throws for a known country. */
  async get(country, fromYear, toYear = fromYear) {
    if (!COUNTRIES[country]) return { country: null, source: 'none', list: [] }
    let data = this.cached(country)
    let source = 'google'
    if (!data || Date.now() - data.at > TTL) {
      // one fetch at a time per country, however many people ask
      if (!this.inflight.has(country)) this.inflight.set(country, this.refresh(country).finally(() => this.inflight.delete(country)))
      try {
        data = await this.inflight.get(country)
      } catch (e) {
        if (!data) {
          console.warn(`[holidays] ${country}: ${e.message}; using built-in fixed dates`)
          source = 'built-in'
          const list = []
          for (let y = fromYear; y <= toYear; y++) list.push(...fixedHolidays(country, y))
          return { country, source, list }
        }
        source = 'cache'
      }
    }
    const list = data.list.filter((h) => {
      const y = Number(h.date.slice(0, 4))
      return y >= fromYear && y <= toYear
    })
    return { country, source, list }
  }
}
