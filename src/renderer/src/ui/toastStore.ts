import { pushUndo, runUndo } from './undoStore'

/** Small notes at the bottom of the window ("Moved to next week · Undo"). One at a time. */
export interface ToastState {
  id: number
  text: string
  tone: 'info' | 'error'
  action?: { label: string; run: () => unknown }
  ms: number
}

let current: ToastState | null = null
let nextId = 1
const listeners = new Set<() => void>()
const set = (next: ToastState | null) => {
  current = next
  listeners.forEach((l) => l())
}

export function toast(
  text: string,
  opts: { tone?: 'info' | 'error'; action?: ToastState['action']; ms?: number } = {}
) {
  let action = opts.action
  // An Undo stays available from the calendar's Undo button after the toast has gone.
  if (action?.label === 'Undo') {
    const entry = pushUndo(text, action.run)
    action = { label: 'Undo', run: () => runUndo(entry.id) }
  }
  set({
    id: nextId++,
    text,
    tone: opts.tone ?? 'info',
    action,
    ms: opts.ms ?? (opts.action ? 8000 : 4500)
  })
}

export function subscribeToast(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const currentToast = () => current
export const clearToast = (id?: number) => {
  if (id === undefined || current?.id === id) set(null)
}
