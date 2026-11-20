import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import type { CalendarController } from '@fullcalendar/react'
import type { Block } from '@shared/types'
import { useTimer } from '../lib/queries'
import { openContextMenu } from '../ui/menuStore'
import { blockMenu, selectionMenu } from './blockMenu'
import { canDelete, deleteBlock } from './deleteBlock'

/**
 * Right-click on calendar blocks, for any page with a PlannerCalendar: returns the handler
 * and the block to highlight (after "Move to next week" it shows that week and the block).
 */
export function useBlockMenu(
  controller: CalendarController,
  open: (block: Block, mode?: 'view' | 'edit') => void,
  duplicate?: (block: Block) => void
) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: timer } = useTimer()
  const [focusId, setFocusId] = useState<string | null>(null)
  // The highlight fades after a few seconds.
  useEffect(() => {
    if (!focusId) return
    const t = setTimeout(() => setFocusId(null), 4000)
    return () => clearTimeout(t)
  }, [focusId])
  const onBlockMenu = (block: Block, e: React.MouseEvent, selection: Block[] = []) => {
    const ctx = {
      qc,
      navigate,
      timer,
      open,
      duplicate,
      reveal: (id: string, date: string) => {
        controller.gotoDate(date)
        setFocus(id)
      }
    }
    openContextMenu(e, selection.length > 1 ? selectionMenu(selection, ctx) : blockMenu(block, ctx))
  }
  // The Delete key on a focused block: deleted at once, with Undo in the toast.
  const onBlockDelete = (block: Block) => {
    if (canDelete(block)) void deleteBlock(block, qc)
  }
  // Highlighting the same block again restarts its highlight (and its 4 seconds).
  const setFocus = (id: string | null) => {
    setFocusId(null)
    if (id) requestAnimationFrame(() => setFocusId(id))
  }
  return { onBlockMenu, onBlockDelete, focusId, setFocus }
}
