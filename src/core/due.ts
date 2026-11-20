import { Temporal } from 'temporal-polyfill'
import { zoned } from './time'

// How far off a deadline is, worked out the same way everywhere it's shown (assignment cards,
// the Deadlines list, the sidebar's countdown).

export type Urgency = 'late' | 'soon' | 'near' | 'far'

export interface DueIn {
  /** Whole days from today to the due day (London): 0 = today, negative = an earlier day. */
  days: number
  /** The due time has passed (so something due at 09:00 is late by the afternoon). */
  late: boolean
  urgency: Urgency
  /** "Today", "Tomorrow", "5 days", "Late" (earlier today), "3d late". */
  label: string
}

function describe(days: number, late: boolean): DueIn {
  const urgency: Urgency = late ? 'late' : days <= 3 ? 'soon' : days <= 7 ? 'near' : 'far'
  const label = late
    ? days < 0
      ? `${-days}d late`
      : 'Late'
    : days === 0
      ? 'Today'
      : days === 1
        ? 'Tomorrow'
        : `${days} days`
  return { days, late, urgency, label }
}

/** A deadline at an instant (UTC ISO). */
export function dueIn(dueIso: string, now: Temporal.Instant): DueIn {
  const days = zoned(now).toPlainDate().until(zoned(dueIso).toPlainDate()).days
  return describe(days, Temporal.Instant.compare(now, Temporal.Instant.from(dueIso)) >= 0)
}

/** A deadline on a day with no time (a dissertation milestone): late only once the day is over. */
export function dueOn(date: Temporal.PlainDate, today: Temporal.PlainDate): DueIn {
  const days = today.until(date).days
  return describe(days, days < 0)
}
