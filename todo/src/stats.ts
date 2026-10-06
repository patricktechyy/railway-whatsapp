import { addDays, todayKey, toKey } from './dates'
import type { Task } from './types'

/** Days in a row (ending today, or yesterday if nothing's done yet today) with at least one task completed. */
export function streakDays(tasks: Task[], today = todayKey()) {
  const days = new Set<string>()
  for (const t of tasks) if (t.done && t.doneAt) days.add(toKey(new Date(t.doneAt)))
  let n = 0
  for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) n++
  return n
}

/** The fire changes colour every two weeks of streak, ending in purple. */
export const FIRE_TIERS = [
  { name: 'red', from: 1 },
  { name: 'orange', from: 15 },
  { name: 'yellow', from: 29 },
  { name: 'green', from: 43 },
  { name: 'blue', from: 57 },
  { name: 'purple', from: 71 },
] as const

export function fireTier(days: number) {
  if (days < 1) return { level: 0, name: 'none', next: null as null | { name: string; in: number } }
  let i = 0
  while (i + 1 < FIRE_TIERS.length && days >= FIRE_TIERS[i + 1].from) i++
  const nextTier = FIRE_TIERS[i + 1]
  return { level: i + 1, name: FIRE_TIERS[i].name, next: nextTier ? { name: nextTier.name, in: nextTier.from - days } : null }
}
