import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { RunningTimer } from '@shared/types'
import { formatClock } from '@core/time'
import { onEvent } from '../lib/api'
import { errorMessage, useCheckins, useExtendTimer, useStopTimer, useTimer } from '../lib/queries'
import { OutcomeDialog } from './OutcomeDialog'
import { OPEN_CHECKINS_EVENT } from '../shell/Rail'
import d from '../shell/Dialog.module.css'

/**
 * App-wide time-tracking dialogs: the one "still working?" prompt when a timer reaches its
 * planned end, and outcome / check-in dialogs for sessions that need an answer. A check-in put
 * off with "Later" comes back the next time the app window is used.
 */
export function TimeTracking() {
  const qc = useQueryClient()
  const { data: timer } = useTimer()
  const { data: checkins = [] } = useCheckins()
  // The prompt shows while the running timer has been prompted and that prompt wasn't answered
  // (derived from the timer itself, so it survives reloads).
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null)
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set())

  useEffect(
    () => onEvent('timer:prompt', () => qc.invalidateQueries({ queryKey: ['timer'] })),
    [qc]
  )

  // "On next app use": snoozed check-ins return when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      setSnoozed(new Set())
      qc.invalidateQueries({ queryKey: ['checkins'] })
      qc.invalidateQueries({ queryKey: ['timer'] })
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener(OPEN_CHECKINS_EVENT, onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(OPEN_CHECKINS_EVENT, onFocus)
    }
  }, [qc])

  if (timer?.promptedAt && timer.promptedAt !== dismissedPrompt) {
    return <StillWorking timer={timer} onClose={() => setDismissedPrompt(timer.promptedAt)} />
  }
  const active = checkins.find((c) => !snoozed.has(c.sessionId))
  if (active) {
    return (
      <OutcomeDialog
        key={active.sessionId}
        mode={{ kind: 'session', item: active }}
        onClose={() => setSnoozed((s) => new Set(s).add(active.sessionId))}
      />
    )
  }
  return null
}

/** The single "still working?" prompt at the planned end, with an extend option. */
function StillWorking({ timer, onClose }: { timer: RunningTimer; onClose: () => void }) {
  const extend = useExtendTimer()
  const stop = useStopTimer()
  const error = extend.error ?? stop.error
  return (
    <div className={d.backdrop}>
      <div className={d.dialog} role="dialog" aria-label="Still working?">
        <header className={d.header}>
          <h2 className={d.title}>Still working?</h2>
        </header>
        <div className={d.body}>
          <p className={d.lead}>
            {timer.title} was planned until {formatClock(timer.plannedEnd)}. Keep the timer going?
          </p>
          <p className={d.muted}>
            If there’s no answer in 10 minutes the timer stops at {formatClock(timer.plannedEnd)},
            and you can correct the time later.
          </p>
          {error && <p className={d.error}>{errorMessage(error)}</p>}
        </div>
        <div className={d.actions}>
          <button
            className={d.secondary}
            onClick={() => stop.mutate(undefined, { onSuccess: onClose })}
          >
            Stop now
          </button>
          <span className={d.spacer} />
          {[15, 30, 60].map((m) => (
            <button
              key={m}
              className={m === 15 ? d.primary : d.secondary}
              onClick={() => extend.mutate(m, { onSuccess: onClose })}
            >
              +{m === 60 ? '1h' : `${m} min`}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
