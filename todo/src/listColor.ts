import { useEffect } from 'react'
import type { List } from './types'

/**
 * List colours are one of the named palette colours ("blue") or your own
 * "#rrggbb". Either way they're used as a class that sets --c, so everything
 * coloured by a list (swatches, calendar chips, bars) works the same.
 */
export const isHex = (c: string | null | undefined) => !!c && /^#[0-9a-f]{6}$/i.test(c)
export const colorClass = (c: string | null | undefined) => `c-${isHex(c) ? `x${c!.slice(1).toLowerCase()}` : c || 'none'}`

/** One <style> with a rule for each custom list colour in use. */
export function useListColorStyles(lists: List[]) {
  const key = [...new Set(lists.map((l) => l.color).filter(isHex).map((c) => c.toLowerCase()))].sort().join(',')
  useEffect(() => {
    let el = document.getElementById('list-colors') as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = 'list-colors'
      document.head.appendChild(el)
    }
    el.textContent = key ? key.split(',').map((c) => `.c-x${c.slice(1)} { --c: ${c}; }`).join('\n') : ''
  }, [key])
}
