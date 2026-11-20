import { useCallback, useState } from 'react'

// Which category calendars are hidden. A per-viewer UI preference, so it lives in
// localStorage (it survives restarts but isn't app data).

const KEY = 'calendar.hiddenCategories'

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function useHiddenCategories() {
  const [hidden, setHidden] = useState<Set<string>>(load)
  const toggle = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]))
      } catch {
        // Storage unavailable: keep the in-memory state only.
      }
      return next
    })
  }, [])
  return { hidden, toggle }
}
