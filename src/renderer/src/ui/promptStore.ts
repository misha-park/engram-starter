/** A one-line question ("Name this lecture") answered in a small dialog; see PromptHost. */
export interface PromptRequest {
  title: string
  initial?: string
  placeholder?: string
  okLabel?: string
  /** Shown under the box. */
  note?: string
  /** Allow an empty answer (e.g. to clear a name). */
  allowEmpty?: boolean
  resolve: (value: string | null) => void
}

let current: PromptRequest | null = null
const listeners = new Set<() => void>()
const set = (next: PromptRequest | null) => {
  current = next
  listeners.forEach((l) => l())
}

/** Resolves with the text, or null if cancelled. */
export function askText(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  current?.resolve(null)
  return new Promise((resolve) => set({ ...opts, resolve }))
}

export function answerPrompt(value: string | null) {
  const req = current
  set(null)
  req?.resolve(value)
}

export function subscribePrompt(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const currentPrompt = () => current
