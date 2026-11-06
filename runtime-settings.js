import fs from 'node:fs'
import { HttpError } from './auth.js'
import { MIN_HISTORY_DAYS, MAX_HISTORY_DAYS } from './store.js'

export const LIMITS = {
  idleMinutes: [5, 1440],
  cooldownMinutes: [10, 1440],
  historyDays: [MIN_HISTORY_DAYS, MAX_HISTORY_DAYS],
}

export function readRuntimeSettings(file) {
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid settings')
    const valid = {}
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const n = stored?.[key]
      if (Number.isInteger(n) && n >= min && n <= max) valid[key] = n
      else if (key === 'historyDays' && Object.hasOwn(stored, key)) valid[key] = MAX_HISTORY_DAYS
    }
    return valid
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    // Falling back to a shorter default could delete history the admin intended to keep.
    console.warn('[settings] Using maximum chat retention until settings can be read', e.code || 'invalid settings')
    return { historyDays: MAX_HISTORY_DAYS }
  }
}

export function updateRuntimeSettings(file, current, body, historyDays) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a settings object')
  const next = { ...current }
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!Object.hasOwn(body, key)) continue
    const n = body[key]
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${key} must be a whole number from ${min} to ${max}`)
    next[key] = n
  }
  if (next.historyDays < historyDays && body.confirmHistoryDays !== next.historyDays) {
    throw new HttpError(409, 'Confirm the shorter retention period before removing older local messages')
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flush: true })
  fs.renameSync(tmp, file)
  return next
}
