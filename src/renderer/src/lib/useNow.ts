import { useEffect, useState } from 'react'
import { Temporal } from 'temporal-polyfill'

/** The current instant, refreshed every `intervalMs` (default: each minute). */
export function useNow(intervalMs = 60_000): Temporal.Instant {
  const [now, setNow] = useState(() => Temporal.Now.instant())
  useEffect(() => {
    const id = setInterval(() => setNow(Temporal.Now.instant()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
