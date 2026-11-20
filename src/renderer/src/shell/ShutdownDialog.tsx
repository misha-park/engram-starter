import { useEffect, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarArrowUp, CircleCheck, Inbox, Moon, X } from 'lucide-react'
import type { Block } from '@shared/types'
import { formatClock, formatMinutes, zoned } from '@core/time'
import { call } from '../lib/api'
import { errorMessage, useCategories } from '../lib/queries'
import d from './Dialog.module.css'
import s from './ShutdownDialog.module.css'
import { blockName } from '../lib/blockName'

const OUTCOME_NOTE: Partial<Record<Block['outcome'], string>> = {
  partial: 'partly done',
  skipped: 'skipped'
}

/**
 * Evening shutdown: what's done today, what's left and what's unfinished. Unfinished work goes
 * to the Backlog or is rescheduled in one action, and tomorrow's first block is previewed.
 */
export function ShutdownDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['shutdown'], queryFn: () => call('shutdown:summary') })
  const { data: categories = [] } = useCategories()
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const colour = (b: Block) =>
    b.colour ?? categories.find((c) => c.id === b.categoryId)?.colour ?? undefined
  const open = [...(data?.unfinished ?? []), ...(data?.left ?? [])]
  const chosen = open.filter((b) => !unchecked.has(b.id)).map((b) => b.id)

  const act = async (kind: 'backlog' | 'reschedule') => {
    setBusy(true)
    setError(null)
    try {
      if (kind === 'backlog') {
        const n = await call('shutdown:backlog', chosen)
        setResult(n ? `Sent ${n} to the Backlog.` : 'Those are in the Backlog already.')
      } else {
        const r = await call('shutdown:reschedule', chosen)
        setResult(
          `Rescheduled ${r.moved} from tomorrow.` +
            (r.notPlaced.length ? ` No time found for: ${r.notPlaced.join(', ')}.` : '')
        )
      }
      await qc.invalidateQueries()
      setUnchecked(new Set())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const Row = ({ b, check }: { b: Block; check?: boolean }) => (
    <li className={`cat ${s.item}`} style={{ '--cat': colour(b) } as CSSProperties}>
      {check ? (
        <input
          type="checkbox"
          className={s.check}
          checked={!unchecked.has(b.id)}
          aria-label={`Include ${blockName(b)}`}
          onChange={(e) =>
            setUnchecked((prev) => {
              const next = new Set(prev)
              if (e.target.checked) next.delete(b.id)
              else next.add(b.id)
              return next
            })
          }
        />
      ) : (
        <CircleCheck size={14} className={s.doneIcon} />
      )}
      <span className={s.dot} />
      <span className={s.itemTitle}>{blockName(b)}</span>
      <span className={`${s.time} num`}>
        {formatClock(b.start)}–{formatClock(b.end)}
        {OUTCOME_NOTE[b.outcome] ? ` · ${OUTCOME_NOTE[b.outcome]}` : ''}
      </span>
    </li>
  )

  const tomorrow = (b: Block) =>
    `${blockName(b)} at ${formatClock(b.start)} (${zoned(b.start)
      .toPlainDate()
      .toLocaleString('en-GB', { weekday: 'long' })})`

  return (
    <div className={d.backdrop} onMouseDown={onClose}>
      <div
        className={`${d.dialog} ${s.dialog}`}
        role="dialog"
        aria-label="Wrap up the day"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={d.header}>
          <h2 className={d.title}>
            <Moon size={15} className={s.moon} /> Wrap up the day
          </h2>
          <button className={d.close} onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        {data && (
          <div className={d.body}>
            <section>
              <h3 className={s.heading}>
                Done today
                <span className={s.muted}> · {formatMinutes(data.loggedMinutes)} logged</span>
              </h3>
              {data.done.length ? (
                <ul className={s.list}>
                  {data.done.map((b) => (
                    <Row key={b.id} b={b} />
                  ))}
                </ul>
              ) : (
                <p className={s.muted}>Nothing marked done yet.</p>
              )}
            </section>

            <section>
              <h3 className={s.heading}>Unfinished and still to do</h3>
              {open.length ? (
                <ul className={s.list}>
                  {data.unfinished.map((b) => (
                    <Row key={b.id} b={b} check />
                  ))}
                  {data.left.length > 0 && data.unfinished.length > 0 && (
                    <li className={s.divider}>Later today</li>
                  )}
                  {data.left.map((b) => (
                    <Row key={b.id} b={b} check />
                  ))}
                </ul>
              ) : (
                <p className={s.muted}>All clear.</p>
              )}
              {result && <p className={s.result}>{result}</p>}
              {error && <p className={d.error}>{error}</p>}
            </section>

            <section className={s.tomorrow}>
              <h3 className={s.heading}>Tomorrow</h3>
              {data.tomorrowFirst ? (
                <p>
                  Starts with {tomorrow(data.tomorrowFirst)}.
                  {data.tomorrowFirstWork &&
                    data.tomorrowFirstWork.id !== data.tomorrowFirst.id && (
                      <span className={s.muted}>
                        {' '}
                        First study block: {tomorrow(data.tomorrowFirstWork)}.
                      </span>
                    )}
                </p>
              ) : (
                <p className={s.muted}>Nothing planned yet.</p>
              )}
            </section>
          </div>
        )}
        <div className={d.actions}>
          <button
            className={`${d.secondary} ${d.withIcon}`}
            disabled={busy || chosen.length === 0}
            onClick={() => void act('backlog')}
          >
            <Inbox size={13} /> Send to Backlog
          </button>
          <span className={d.spacer} />
          <button
            className={`${d.primary} ${d.withIcon}`}
            disabled={busy || chosen.length === 0}
            onClick={() => void act('reschedule')}
          >
            <CalendarArrowUp size={13} /> Reschedule from tomorrow
          </button>
        </div>
      </div>
    </div>
  )
}
