import { useState } from 'react'

/**
 * Local state for an editable field that follows its saved value: it starts as `saved` and is
 * reset whenever `saved` changes (a save, or a change made elsewhere), but nothing else that
 * refreshes the page touches what you're typing.
 */
export function useSynced<T>(saved: T): [T, (v: T) => void] {
  const [value, setValue] = useState(saved)
  const [last, setLast] = useState(saved)
  if (!Object.is(saved, last)) {
    setLast(saved)
    setValue(saved)
  }
  return [value, setValue]
}
