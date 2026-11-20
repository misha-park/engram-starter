import type { DragEvent } from 'react'
import { call } from './api'
import { errorMessage } from './queries'
import { toast } from '../ui/toastStore'

/** Copy a file to the Downloads folder and say so, with a way to find it. */
export async function saveToDownloads(id: string): Promise<void> {
  try {
    const { name } = await call('files:download', id)
    toast(`Saved to Downloads as “${name}”.`, {
      action: { label: 'Show in Finder', run: () => call('files:revealDownload', id) }
    })
  } catch (e) {
    toast(errorMessage(e), { tone: 'error' })
  }
}

/**
 * Drag a file out of Engram as a real file (into Finder, GoodNotes, a shelf app…). Use as an
 * element's `onDragStart`, with `draggable`.
 */
export function dragFile(e: DragEvent, id: string): void {
  e.preventDefault()
  call('files:startDrag', id).catch((err) => toast(errorMessage(err), { tone: 'error' }))
}

/** Put a file on the clipboard, ready to paste into Finder or another app. */
export async function copyFile(id: string, name: string): Promise<void> {
  try {
    await call('files:copy', id)
    toast(`Copied “${name}”.`)
  } catch (e) {
    toast(errorMessage(e), { tone: 'error' })
  }
}
