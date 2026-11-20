import { useEffect } from 'react'
import { errorMessage } from '../lib/queries'
import { toast } from './toastStore'
import { isTextTarget, isUndoKey } from './undoKey'
import { latestUndo, runUndo } from './undoStore'

/** ⌘Z on any page undoes the latest change with an Undo, unless you're typing in a field. */
export function useUndoShortcut() {
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (!isUndoKey(e) || isTextTarget(document.activeElement as HTMLElement | null)) return
      e.preventDefault()
      const last = latestUndo()
      if (!last) {
        toast('Nothing to undo.', { ms: 1500 })
        return
      }
      try {
        await runUndo(last.id)
        toast(`Undone: ${last.label.replace(/\.$/, '')}.`)
      } catch (err) {
        toast(errorMessage(err), { tone: 'error' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
