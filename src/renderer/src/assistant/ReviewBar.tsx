import { useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import type { BatchSummary } from '@shared/types'
import { errorMessage } from '../lib/queries'
import { useAssistant } from './store'
import s from './ReviewBar.module.css'

/** Above the calendar while a larger assistant change waits: what changed, keep or put back. */
export function ReviewBar({ batch }: { batch: BatchSummary }) {
  const a = useAssistant()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (fn: (b: BatchSummary) => Promise<void>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn(batch)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const shown = batch.lines.slice(0, 3)
  return (
    <div className={s.bar} role="region" aria-label="Changes to review">
      <Sparkles size={14} className={s.icon} />
      <div className={s.text}>
        <strong>
          Claude made {batch.changeCount} change{batch.changeCount === 1 ? '' : 's'}
        </strong>
        <span className={s.lines} title={batch.lines.join('\n')}>
          {shown.join(' · ')}
          {batch.lines.length > shown.length && ` · +${batch.lines.length - shown.length} more`}
        </span>
        {error && <span className={s.error}>{error}</span>}
      </div>
      <button className={s.secondary} disabled={busy} onClick={act(a.reject)}>
        Reject
      </button>
      <button className={s.primary} disabled={busy} onClick={act(a.accept)}>
        <Check size={12} /> Accept
      </button>
    </div>
  )
}
