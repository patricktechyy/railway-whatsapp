import type { Repeat } from './repeat.js'
export interface Link { url: string; title: string }
export interface Parsed {
  title: string
  hints: string[]
  due?: string
  time?: string
  priority?: 0 | 1 | 2 | 3
  tags?: string[]
  listId?: string
  repeat?: Repeat
  links?: Link[]
}
export function parseQuickAdd(input: string, lists: { id: string; name: string; emoji: string }[], today?: string): Parsed
export function cleanUrl(raw: string): string | null
export function hostOf(url: string): string
