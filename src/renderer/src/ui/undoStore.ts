/**
 * The calendar's Undo button: the latest changes that can be taken back, newest last.
 * A toast with an "Undo" action adds itself here, and so do calendar drags and new events.
 */
export interface UndoEntry {
  id: number
  /** What it undoes, e.g. "Moved to next week, same time." */
  label: string
  run: () => unknown
}

const MAX = 30
let stack: UndoEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

export function pushUndo(label: string, run: () => unknown): UndoEntry {
  const entry = { id: nextId++, label, run }
  stack = [...stack, entry].slice(-MAX)
  changed()
  return entry
}

/** Undo one entry (once: it leaves the stack first, so a second click can't repeat it). */
export async function runUndo(id: number): Promise<void> {
  const entry = stack.find((e) => e.id === id)
  if (!entry) return
  stack = stack.filter((e) => e.id !== id)
  changed()
  await entry.run()
}

export const latestUndo = (): UndoEntry | null => stack.at(-1) ?? null

export function subscribeUndo(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
