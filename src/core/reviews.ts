import { Temporal } from 'temporal-polyfill'
import type { ReviewRating } from '../shared/types'

// Spaced repetition for written-up lectures (experimental). Pure rules; the main process
// stores reviews and places their blocks through the scheduler.

/** Days from the write-up (for review 1) or the previous review to the next one. */
export const REVIEW_INTERVALS = [1, 3, 7, 21, 60] as const
export const REVIEW_STEPS = REVIEW_INTERVALS.length
/** Length of one guided review session. */
export const REVIEW_MINUTES = 30
/** How a rating stretches (easy) or shortens (hard) the next interval. */
export const RATING_FACTOR: Record<ReviewRating, number> = { easy: 1.5, ok: 1, hard: 0.5 }
/** A review is placed on its due date, or within this many days after it if that's full. */
export const REVIEW_PLACEMENT_DAYS = 3

/**
 * Days until review `nextStep` (1-based), counted from the write-up or the previous review.
 * The first interval is fixed; later ones scale with the previous review's rating
 * (no rating counts as "ok"). Null once the sequence is finished.
 */
export function intervalBefore(
  nextStep: number,
  previousRating: ReviewRating | null
): number | null {
  if (nextStep < 1 || nextStep > REVIEW_STEPS) return null
  const base = REVIEW_INTERVALS[nextStep - 1]
  if (nextStep === 1) return base
  return Math.max(1, Math.round(base * RATING_FACTOR[previousRating ?? 'ok']))
}

/** The due date of review `nextStep`, from the day the previous step was finished. */
export function nextDue(
  finishedOn: Temporal.PlainDate,
  nextStep: number,
  previousRating: ReviewRating | null
): Temporal.PlainDate | null {
  const days = intervalBefore(nextStep, previousRating)
  return days === null ? null : finishedOn.add({ days })
}

export function reviewStatus(
  due: string,
  doneAt: string | null,
  today: Temporal.PlainDate
): 'overdue' | 'today' | 'upcoming' | 'done' {
  if (doneAt) return 'done'
  const c = Temporal.PlainDate.compare(Temporal.PlainDate.from(due), today)
  return c < 0 ? 'overdue' : c === 0 ? 'today' : 'upcoming'
}
