import { Temporal } from 'temporal-polyfill'
import { formatMinutes, minutesBetween, toIso, weekRange, zoned } from '../../core/time'
import type { WeeklyReview } from '../../shared/types'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { getSetting, listBlocksInRange, listDeadlines } from '../repo'
import { dayLabel } from './placement'
import { weekSummary } from './tools'

// The Sunday weekly review: hours vs target, what slipped, next week's load. The numbers are
// worked out here; Claude only writes them up. Sent as a macOS notification on Sunday evening.

export const REVIEW_KEY = 'weeklyReview'
/** The review is written from this time on Sundays (if the app is open). */
export const REVIEW_FROM = '18:00'

export const REVIEW_SYSTEM = `You write a student's short weekly review for their study planner. Use only the numbers given. Three short parts, no headings: how the week went against the target; what slipped (by name, briefly); what next week holds (load and deadlines). At most 90 words, plain UK English, no advice or suggestions beyond stating the facts, no praise or pep talk.`

export function latestReview(db: Db): WeeklyReview | null {
  return getSetting<WeeklyReview>(db, REVIEW_KEY)
}

/** Sunday from 18:00, if this week's review hasn't been written yet. */
export function isReviewDue(db: Db, now: Temporal.Instant): boolean {
  const z = zoned(now)
  if (z.dayOfWeek !== 7) return false
  const [h, m] = REVIEW_FROM.split(':').map(Number)
  if (z.hour * 60 + z.minute < h * 60 + m) return false
  return latestReview(db)?.weekStart !== toIso(weekRange(now).start)
}

/** What the review is written from. */
export function reviewData(db: Db, now: Temporal.Instant) {
  const next = weekRange(now).end
  const nextEnd = next.add({ days: 7 })
  const planned = listBlocksInRange(db, toIso(next), toIso(nextEnd)).filter(
    (b) => b.kind === 'flexible'
  )
  return {
    thisWeek: weekSummary(db, now),
    nextWeek: {
      from: dayLabel(toIso(next)),
      plannedStudy: formatMinutes(
        planned.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0)
      ),
      plannedBlocks: planned.length,
      deadlines: listDeadlines(db, toIso(next), toIso(nextEnd)).map(
        (d) => `${d.title} (${dayLabel(d.at)})`
      )
    }
  }
}

export function saveReview(db: Db, review: WeeklyReview): void {
  db.insert(t.settings)
    .values({ key: REVIEW_KEY, value: review })
    .onConflictDoUpdate({ target: t.settings.key, set: { value: review } })
    .run()
}

/** Write this week's review with Claude and store it. */
export async function writeReview(
  db: Db,
  now: Temporal.Instant,
  complete: (system: string, prompt: string) => Promise<string>
): Promise<WeeklyReview> {
  const text = await complete(
    REVIEW_SYSTEM,
    `The week's numbers:\n${JSON.stringify(reviewData(db, now), null, 2)}`
  )
  const review: WeeklyReview = {
    weekStart: toIso(weekRange(now).start),
    at: toIso(now),
    text
  }
  saveReview(db, review)
  return review
}
