import { Temporal } from 'temporal-polyfill'

// Term 2's end, inferred from the timetable (there is deliberately no term-dates setup):
// the last lecture between January and June of this academic year, followed by 14 days with
// no lectures at all.

export const TERM_END_GAP_DAYS = 14

/** The calendar year whose January–June is this academic year's term 2 (years run Sep–Aug). */
export function termTwoYear(today: Temporal.PlainDate): number {
  return today.month >= 9 ? today.year + 1 : today.year
}

/**
 * The date term 2 ended, if it has: the last Jan–Jun lecture, once 14 lecture-free days have
 * passed after it. Null before then, or when the timetable has no term 2 lectures.
 */
export function termTwoEnd(
  lectureDates: Temporal.PlainDate[],
  today: Temporal.PlainDate
): Temporal.PlainDate | null {
  const year = termTwoYear(today)
  const sorted = [...lectureDates].sort(Temporal.PlainDate.compare)
  const inTerm = sorted.filter((d) => d.year === year && d.month <= 6)
  const last = inTerm.at(-1)
  if (!last) return null
  const gapEnd = last.add({ days: TERM_END_GAP_DAYS })
  const lectureInGap = sorted.some(
    (d) => Temporal.PlainDate.compare(d, last) > 0 && Temporal.PlainDate.compare(d, gapEnd) <= 0
  )
  if (lectureInGap) return null
  return Temporal.PlainDate.compare(today, gapEnd) >= 0 ? last : null
}
