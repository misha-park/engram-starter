import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { call } from '../../lib/api'
import { errorMessage } from '../../lib/queries'

export const useDissertation = () =>
  useQuery({ queryKey: ['dissertation'], queryFn: () => call('diss:overview') })

/**
 * Run a dissertation change, then refresh everything it can touch (the page, todos from
 * meetings, session blocks and deadlines). Keeps the last error for the caller to show.
 */
export function useDissAction() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      await qc.invalidateQueries()
      return result
    } catch (e) {
      setError(errorMessage(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { run, error, busy, clearError: () => setError(null) }
}
