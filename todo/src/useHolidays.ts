import { useEffect, useState } from 'react'
import { api } from './api'

type Result = { country: string | null; source: string; list: { date: string; name: string }[] }
const cache = new Map<string, Promise<Result>>()

/** Public holidays for the years in view, as a map of date → names. Fetched once per country + years. */
export function useHolidays(country: string | undefined, fromYear: number, toYear = fromYear) {
  const [map, setMap] = useState<Map<string, string[]>>(new Map())
  useEffect(() => {
    if (!country || country === 'off') { setMap(new Map()); return }
    const key = `${country}|${fromYear}|${toYear}`
    if (!cache.has(key)) cache.set(key, api<Result>(`/holidays?country=${country}&from=${fromYear}&to=${toYear}`).catch(() => { cache.delete(key); return { country, source: 'error', list: [] } }))
    let live = true
    cache.get(key)!.then((r) => {
      if (!live) return
      const m = new Map<string, string[]>()
      for (const h of r.list) m.set(h.date, [...(m.get(h.date) || []), h.name])
      setMap(m)
    })
    return () => { live = false }
  }, [country, fromYear, toYear])
  return map
}
