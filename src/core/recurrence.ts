import { Temporal } from 'temporal-polyfill'
import type { RecurrenceRule } from '../shared/types'
import { localRange, type ZonedDateTime } from './time'

/**
 * Local dates in [from, to] on which a weekly rule occurs, starting no earlier than
 * `startsOn`, ending no later than `until`, and skipping `exdates` (removed occurrences).
 */
export function occurrenceDates(
  rule: RecurrenceRule,
  opts: {
    startsOn: string
    until?: string | null
    exdates?: string[]
    from: Temporal.PlainDate
    to: Temporal.PlainDate
  }
): Temporal.PlainDate[] {
  const startsOn = Temporal.PlainDate.from(opts.startsOn)
  const first = Temporal.PlainDate.compare(opts.from, startsOn) > 0 ? opts.from : startsOn
  const last =
    opts.until && Temporal.PlainDate.compare(Temporal.PlainDate.from(opts.until), opts.to) < 0
      ? Temporal.PlainDate.from(opts.until)
      : opts.to
  const skip = new Set(opts.exdates ?? [])
  const dates: Temporal.PlainDate[] = []
  for (let d = first; Temporal.PlainDate.compare(d, last) <= 0; d = d.add({ days: 1 })) {
    if (rule.byWeekday.includes(d.dayOfWeek) && !skip.has(d.toString())) dates.push(d)
  }
  return dates
}

/** Start and end of the occurrence on `date` (an end at or before the start rolls to the next day). */
export function occurrenceRange(
  rule: RecurrenceRule,
  date: Temporal.PlainDate | string
): { start: ZonedDateTime; end: ZonedDateTime } {
  return localRange(date, rule.startTime, rule.endTime)
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** "Saturdays 17:00–00:00" */
export function describeRule(rule: RecurrenceRule): string {
  const days = rule.byWeekday.map((d) => `${WEEKDAY_NAMES[d - 1]}s`).join(', ')
  return `${days} ${rule.startTime}–${rule.endTime}`
}

export function weekdayName(isoWeekday: number): string {
  return WEEKDAY_NAMES[isoWeekday - 1]
}
