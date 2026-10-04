// Types for repeat.js, which is shared with the browser app.
export type Freq = 'day' | 'week' | 'month' | 'year'
export interface Repeat {
  freq: Freq
  interval: number
  weekdays?: number[]
  until?: string | null
}
export const FREQS: Freq[]
export function cleanRepeat(v: unknown): Repeat | null
export function nextOccurrence(due: string | null, repeat: Repeat | null): string | null
export function occurrencesBetween(due: string, repeat: Repeat, first: string, last: string, max?: number): string[]
export function describeRepeat(repeat: Repeat | null): string
