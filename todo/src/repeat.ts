// The repeat rules live in server/repeat.js so the server and the browser agree exactly.
export { FREQS, nextOccurrence, occurrencesBetween, describeRepeat } from '../server/repeat.js'
export type { Freq, Repeat } from '../server/repeat.js'
import type { Repeat } from '../server/repeat.js'

export const REPEAT_PRESETS: { label: string; value: Repeat | null }[] = [
  { label: 'Never', value: null },
  { label: 'Daily', value: { freq: 'day', interval: 1 } },
  { label: 'Weekly', value: { freq: 'week', interval: 1 } },
  { label: 'Monthly', value: { freq: 'month', interval: 1 } },
  { label: 'Yearly', value: { freq: 'year', interval: 1 } },
]

/** Is this repeat one of the simple presets (as opposed to Custom)? */
export const isPreset = (r: Repeat | null) => !r || (r.interval === 1 && !r.weekdays?.length && !r.until)
