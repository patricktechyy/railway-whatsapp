import fs from 'node:fs'
import path from 'node:path'
import { todayIn } from './tz.js'

/**
 * How much of Groq's free tier Buddy's AI is using, for the main admin's AI card.
 *
 * Groq's free tier (gpt-oss models): 1,000 requests a day, 200,000 tokens a day, 8,000 tokens a
 * minute. Groq tells us the requests left today and the tokens left this minute on every answer
 * (x-ratelimit-* headers); the tokens per day it doesn't, so we add those up ourselves from each
 * answer's `usage`. Cached tokens don't count towards Groq's limits, so they're kept apart.
 * Groq doesn't say when its day starts, so the token count is for the last 24 hours.
 */
export const FREE_TIER = { requestsPerDay: 1000, tokensPerDay: 200000, tokensPerMinute: 8000 }
const DAY = 864e5

export class AiUsage {
  constructor(dataDir, { tz = () => 'UTC', now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'ai-usage.json')
    this.tz = tz
    this.now = now
    let d = {}
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
    this.calls = Array.isArray(d.calls) ? d.calls : [] // the last 24 hours, one per request to Groq
    this.days = d.days && typeof d.days === 'object' ? d.days : {} // day → totals (the main admin's days), 30 days
    this.limits = d.limits || null // what Groq's headers said last time
    this.lastError = d.lastError || null
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ calls: this.calls, days: this.days, limits: this.limits, lastError: this.lastError }))
    fs.renameSync(tmp, this.file)
  }

  /** One request to Groq. `who`: whose message it was ('(test)' for the Test AI button). */
  record(who, { ok, model = null, usage = null, limits = null, error = null, ms = 0 } = {}) {
    const at = this.now()
    const total = Number(usage?.total_tokens) || (Number(usage?.prompt_tokens) || 0) + (Number(usage?.completion_tokens) || 0)
    const cached = Number(usage?.prompt_tokens_details?.cached_tokens) || 0
    const counted = Math.max(0, total - cached)
    this.calls = [...this.calls.filter((c) => at - c.at < DAY), { at, who: String(who || '?'), ok: !!ok, total, counted, prompt: Number(usage?.prompt_tokens) || 0, completion: Number(usage?.completion_tokens) || 0, ms: Math.round(ms) }].slice(-3000)
    const day = todayIn(this.tz(), at)
    const d = (this.days[day] ||= { requests: 0, failed: 0, tokens: 0, counted: 0 })
    d.requests++
    if (!ok) d.failed++
    d.tokens += total
    d.counted += counted
    const keep = Object.keys(this.days).sort().slice(-30)
    this.days = Object.fromEntries(keep.map((k) => [k, this.days[k]]))
    if (limits && Object.values(limits).some((v) => v !== null && v !== undefined)) this.limits = { ...limits, at, model }
    if (!ok && error) this.lastError = { at, error: String(error).slice(0, 200) }
    try { this.save() } catch (e) { console.warn(`[buddy] couldn't save AI usage: ${e.message}`) }
  }

  /** For the admin card. `nameOf(u)`: a person's name. */
  view(nameOf = (u) => u) {
    const at = this.now()
    const calls = this.calls.filter((c) => at - c.at < DAY)
    const answered = calls.filter((c) => c.ok && c.total)
    const counted = calls.reduce((n, c) => n + c.counted, 0)
    const avg = answered.length ? Math.round(answered.reduce((n, c) => n + c.counted, 0) / answered.length) : null
    const people = {}
    for (const c of calls) {
      const p = (people[c.who] ||= { who: c.who, name: c.who === '(test)' ? 'Test AI button' : nameOf(c.who) || c.who, requests: 0, tokens: 0 })
      p.requests++
      p.tokens += c.counted
    }
    const today = todayIn(this.tz(), at)
    const days = []
    for (let i = 13; i >= 0; i--) {
      const k = todayIn(this.tz(), at - i * DAY)
      days.push({ day: k, ...(this.days[k] || { requests: 0, failed: 0, tokens: 0, counted: 0 }) })
    }
    const minuteAgo = calls.filter((c) => at - c.at < 60e3).reduce((n, c) => n + c.counted, 0)
    return {
      free: FREE_TIER,
      last24h: { requests: calls.length, failed: calls.filter((c) => !c.ok).length, tokens: counted, avgPerAnswer: avg, answersLeft: avg ? Math.max(0, Math.floor((FREE_TIER.tokensPerDay - counted) / avg)) : null },
      lastMinute: { tokens: minuteAgo },
      today: this.days[today] || { requests: 0, failed: 0, tokens: 0, counted: 0 },
      groq: this.limits, // { requestsPerDay, requestsLeft, requestsReset, tokensPerMinute, tokensLeft, tokensReset, at, model }
      lastError: this.lastError,
      people: Object.values(people).sort((a, b) => b.tokens - a.tokens),
      days: days.slice(-14),
    }
  }
}

/** Groq's rate-limit headers → numbers (requests: per day; tokens: per minute). */
export function limitsOf(headers) {
  const h = (k) => headers?.get?.(k) ?? null
  const n = (k) => { const v = h(k); return v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v) }
  return {
    requestsPerDay: n('x-ratelimit-limit-requests'),
    requestsLeft: n('x-ratelimit-remaining-requests'),
    requestsReset: h('x-ratelimit-reset-requests'),
    tokensPerMinute: n('x-ratelimit-limit-tokens'),
    tokensLeft: n('x-ratelimit-remaining-tokens'),
    tokensReset: h('x-ratelimit-reset-tokens'),
    retryAfter: n('retry-after'),
  }
}
