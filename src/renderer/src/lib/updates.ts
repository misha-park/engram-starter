// Restart to update and Roll back (docs/ORIGINAL-SPEC.md §9): the top bar's button and Settings → Updates.
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call, onEvent } from './api'

/** The installed app's update state; refreshed when `npm run release` stages a build. */
export function useUpdateStatus() {
  const qc = useQueryClient()
  useEffect(
    () => onEvent('update:changed', () => void qc.invalidateQueries({ queryKey: ['update'] })),
    [qc]
  )
  return useQuery({ queryKey: ['update'], queryFn: () => call('update:status') })
}

/**
 * Back up, then quit and come back on the new version. If the backup fails, ask whether to
 * update anyway. Resolves false when nothing happened (the user said no).
 */
export async function restartToUpdate(): Promise<boolean> {
  const r = await call('update:restart')
  if (!r) return true
  const anyway = window.confirm(
    `The backup before updating failed: ${r.backupError}\n\nUpdate anyway? Engram still keeps a copy of the database before the new version changes it.`
  )
  if (anyway) await call('update:restart', { skipBackup: true })
  return anyway
}
