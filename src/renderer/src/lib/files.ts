import { useRef, useState, type DragEvent } from 'react'

// Files dragged in from Finder. Electron gives the renderer File objects; their paths come
// from the preload (webUtils). Main copies the files into the profile.

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

/** Paths of the files in a drop (folders included; main refuses them with a message). */
export function droppedPaths(e: DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => window.api.pathForFile(f))
    .filter(Boolean)
}

/** Drag-and-drop handlers for a drop zone, and whether files are over it. */
export function useFileDrop(onPaths: (paths: string[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  return {
    over,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current++
        setOver(true)
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        depth.current = 0
        setOver(false)
        const paths = droppedPaths(e)
        if (paths.length) onPaths(paths)
      }
    }
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Window event asking the app to open "Plan from brief" (Claude's plan_assignment_from_brief). */
export const PLAN_BRIEF_EVENT = 'engram:plan-brief'
export const requestBriefPlan = (attachmentId: string, assignmentId: string | null) =>
  window.dispatchEvent(
    new CustomEvent(PLAN_BRIEF_EVENT, { detail: { attachmentId, assignmentId } })
  )
