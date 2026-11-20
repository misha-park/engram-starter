import type { QueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import { askText } from '../ui/promptStore'
import { toast } from '../ui/toastStore'

// Deleting an assignment or a stage, with an Undo that puts back everything it touched
// (its stages, its planned blocks and any work re-planned because of it).

const undoToast = (qc: QueryClient, text: string, undo: string) =>
  toast(text, {
    action: {
      label: 'Undo',
      run: async () => {
        await call('assignments:undoDelete', undo)
        await qc.invalidateQueries()
      }
    }
  })

export async function deleteAssignment(qc: QueryClient, x: { id: string; title: string }) {
  const undo = await call('assignments:delete', x.id)
  await qc.invalidateQueries()
  undoToast(qc, `Deleted “${x.title}”.`, undo)
}

export async function removeStage(qc: QueryClient, stage: { id: string; name: string }) {
  const undo = await call('stages:remove', stage.id)
  await qc.invalidateQueries()
  undoToast(qc, `Removed “${stage.name}”.`, undo)
}

/** Ask for a new name for an assignment (its calendar blocks follow). */
export async function renameAssignment(qc: QueryClient, x: { id: string; title: string }) {
  const title = await askText({ title: 'Rename assignment', initial: x.title, okLabel: 'Rename' })
  if (title === null || !title.trim() || title.trim() === x.title) return
  try {
    await call('assignments:update', x.id, { title })
    await qc.invalidateQueries()
  } catch (e) {
    toast(errorMessage(e), { tone: 'error' })
  }
}
