import type { QueryClient } from '@tanstack/react-query'
import type { Block } from '@shared/types'
import { call } from '../lib/api'
import { blockName } from '../lib/blockName'
import { errorMessage } from '../lib/queries'
import { toast } from '../ui/toastStore'

/** Any block but a timetabled one (those are hidden) or one of a series (remove the occurrence). */
export const canDelete = (b: Block) => b.source !== 'timetable' && !b.recurrenceId

/** What deleting this block also does, asked before it's deleted. */
export function deleteQuestion(b: Block): string {
  const name = `“${blockName(b)}”`
  if (b.type === 'write-up' && b.linkedType === 'lecture')
    return `Delete ${name}? The lecture won’t get another write-up.`
  if (b.linkedType === 'assignment-stage')
    return `Delete ${name}? Its stage needs that much less time.`
  return `Delete ${name}?`
}

/** Delete it, saying what else changed, with Undo. */
export async function deleteBlock(b: Block, qc: QueryClient): Promise<void> {
  try {
    const { note, undo } = await call('blocks:delete', b.id)
    await qc.invalidateQueries()
    toast(`Deleted “${blockName(b)}”.${note ? ` ${note}` : ''}`, {
      action: undo
        ? {
            label: 'Undo',
            run: async () => {
              await call('blocks:undoDelete', undo)
              await qc.invalidateQueries()
            }
          }
        : undefined
    })
  } catch (e) {
    toast(errorMessage(e), { tone: 'error' })
  }
}

/**
 * Take a timetabled event off the calendar (later imports leave it out), with Undo; Settings →
 * Timetable can bring it back later too. Throws, so a dialog can show the error.
 */
export async function hideTimetabled(b: Block, qc: QueryClient): Promise<void> {
  const { undo } = await call('timetable:hideBlock', b.id)
  await qc.invalidateQueries()
  toast(`Deleted “${blockName(b)}”. Settings → Timetable can bring it back.`, {
    action: {
      label: 'Undo',
      run: async () => {
        await call('blocks:undoDelete', undo)
        await qc.invalidateQueries()
      }
    }
  })
}
