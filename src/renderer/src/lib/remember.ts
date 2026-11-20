import { useCallback, useState } from 'react'

// "Pick up where you left off": small UI state kept across launches (the last page, whether the
// Claude panel was open, the calendar's view and scroll, collapsed sections). It lives in
// localStorage, one set per profile, so demo and real never share it. It isn't app data, so a
// failure to read or write just means the default is used.

let profile: string | null = null

/**
 * Called at startup with the active profile, before anything reads (WithProfile waits for it).
 * At launch, when no page is in the address, it reopens the last page; a reload (switching
 * profile, dev reloads) stays where it is.
 */
export function startRemembering(name: string) {
  if (profile !== null) return
  profile = name
  const hash = window.location.hash
  if (!hash || hash === '#' || hash === '#/') {
    const last = remembered<string | null>('lastPage', null)
    if (last && last.startsWith('/') && last !== '/') history.replaceState(null, '', `#${last}`)
  }
}

const fullKey = (key: string) => `${profile ?? 'demo'}:${key}`

/** What was kept under `key` for this profile, or `fallback`. */
export function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(fullKey(key))
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

/** Keep `value` under `key` for this profile. */
export function remember<T>(key: string, value: T) {
  try {
    localStorage.setItem(fullKey(key), JSON.stringify(value))
  } catch {
    // Not kept: the default comes back next launch.
  }
}

/** useState that is kept across launches. */
export function useRemembered<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState(() => remembered(key, fallback))
  const set = useCallback(
    (next: T) => {
      setValue(next)
      remember(key, next)
    },
    [key]
  )
  return [value, set]
}
