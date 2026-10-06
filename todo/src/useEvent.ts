import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function that never changes identity but always runs the latest version of
 * `fn`. Handing these to memoised rows means a re-render up top doesn't redraw
 * every row just because its click handlers were created anew.
 */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => { ref.current = fn })
  return useCallback((...args: A) => ref.current(...args), [])
}
