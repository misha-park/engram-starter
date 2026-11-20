import { Temporal } from 'temporal-polyfill'

/** How long the "still working?" prompt waits for an answer before the timer stops itself. */
export const PROMPT_GRACE_MINUTES = 10

/** Gaps shorter than this between sessions don't count as a break. */
export const BREAK_GAP_MINUTES = 10

export type TimerPhase = 'running' | 'prompt' | 'timed-out'

/**
 * Where a running timer is: before its planned end it is running; from the planned end it
 * asks once whether you're still working; with no answer after the grace period it times out
 * (and stops at the planned end).
 */
export function timerPhase(plannedEnd: string, now: Temporal.Instant): TimerPhase {
  const end = Temporal.Instant.from(plannedEnd)
  if (Temporal.Instant.compare(now, end) < 0) return 'running'
  const deadline = end.add({ minutes: PROMPT_GRACE_MINUTES })
  return Temporal.Instant.compare(now, deadline) < 0 ? 'prompt' : 'timed-out'
}

/**
 * When a timer started at `now` for a block should prompt: the block's planned end, or, when
 * starting late (less than 5 minutes of the block left), now plus the block's planned length.
 */
export function initialPlannedEnd(
  block: { start: string; end: string },
  now: Temporal.Instant
): string {
  const end = Temporal.Instant.from(block.end)
  if (Temporal.Instant.compare(end, now.add({ minutes: 5 })) > 0) return block.end
  const length = Temporal.Instant.from(block.start).until(end)
  return now.add(length).toString({ smallestUnit: 'second' })
}

/** "1:05:09" or "25:13" */
export function elapsed(startIso: string, now: Temporal.Instant): string {
  const total = Math.max(
    0,
    Math.floor(now.since(Temporal.Instant.from(startIso)).total({ unit: 'seconds' }))
  )
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
