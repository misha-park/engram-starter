/**
 * ⌘Z anywhere in the app takes back the latest change that has an Undo (see `undoStore.ts`),
 * except where the focus is in something you type into: there the text's own undo wins.
 * Plain logic (no DOM types needed) so it can be tested in Node.
 */

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  repeat: boolean
}

interface TargetLike {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

/** Plain ⌘Z (not ⇧⌘Z, not held down). */
export const isUndoKey = (e: KeyLike): boolean =>
  e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.repeat && e.key.toLowerCase() === 'z'

// Inputs that hold no text of their own, so ⌘Z there means the app's undo.
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image'
])

/** Whether the focused element has its own text undo (inputs, textareas, contenteditable). */
export function isTextTarget(t: TargetLike | null | undefined): boolean {
  if (!t) return false
  if (t.isContentEditable) return true
  const tag = t.tagName?.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((t.type ?? 'text').toLowerCase())
  return false
}
