import { randomUUID } from 'crypto'
import { and, asc, eq, gt, inArray, lt, ne } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import {
  nextDue,
  REVIEW_MINUTES,
  REVIEW_PLACEMENT_DAYS,
  REVIEW_STEPS,
  reviewStatus
} from '../core/reviews'
import { findSlot } from '../core/scheduler'
import { atLocalTime, todayLocalDate, toIso, weekRange, zoned } from '../core/time'
import type { LectureReviews, ReviewItem, ReviewRating, RevisionOverview } from '../shared/types'
import { getAvailability, getBlock, logChange } from './calendar'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'
import { lectureLine } from '../core/lectures'
import { appendToRecord, targetForBlock } from './records'
import { listModules } from './repo'
import { markOutcome } from './sessions'

// Spaced repetition (experimental): each written-up lecture gets 30-minute review sessions at
// growing intervals. Kept in its own table, page and module so it is easy to remove.

const OUTSIDE_NOTE = 'Placed outside your availability: nothing else fitted near its due date.'

function lectureInfo(db: DbOrTx, lectureId: string) {
  return db
    .select({ lecture: t.lectures, title: t.blocks.title, categoryId: t.modules.categoryId })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .innerJoin(t.modules, eq(t.lectures.moduleId, t.modules.id))
    .where(eq(t.lectures.id, lectureId))
    .get()
}

/**
 * Give an open review a 30-minute block: on its due date (or today, if that has passed), else
 * within a few days after, inside availability where possible. Returns the block id, or null.
 */
export function placeReview(db: Db, reviewId: string, now: Temporal.Instant): string | null {
  const review = db.select().from(t.reviews).where(eq(t.reviews.id, reviewId)).get()
  if (!review || review.doneAt) return null
  const info = lectureInfo(db, review.lectureId)
  if (!info) return null

  const today = todayLocalDate(now)
  let day = Temporal.PlainDate.from(review.due)
  if (Temporal.PlainDate.compare(day, today) < 0) day = today
  const from =
    Temporal.Instant.compare(atLocalTime(day, '00:00').toInstant(), now) < 0
      ? now
      : atLocalTime(day, '00:00').toInstant()
  const until = atLocalTime(day.add({ days: REVIEW_PLACEMENT_DAYS + 1 }), '00:00').toInstant()
  const busy = db
    .select({ start: t.blocks.start, end: t.blocks.end })
    .from(t.blocks)
    .where(
      and(
        lt(t.blocks.start, toIso(until)),
        gt(t.blocks.end, toIso(from)),
        ne(t.blocks.outcome, 'skipped')
      )
    )
    .all()
  const slot = findSlot({
    from: toIso(from),
    until: toIso(until),
    durationMinutes: REVIEW_MINUTES,
    busy,
    availability: getAvailability(db)
  })
  if (!slot) return null

  const blockId = `rv-${randomUUID().slice(0, 12)}`
  db.transaction((tx) => {
    tx.insert(t.blocks)
      .values({
        id: blockId,
        kind: 'flexible',
        type: 'review',
        title: `${info.title} review ${review.step}`,
        start: slot.start,
        end: slot.end,
        categoryId: info.categoryId,
        linkedType: 'lecture',
        linkedId: review.lectureId,
        source: 'auto',
        attention: slot.withinAvailability ? null : OUTSIDE_NOTE
      })
      .run()
    tx.update(t.reviews).set({ blockId }).where(eq(t.reviews.id, reviewId)).run()
  })
  return blockId
}

/** Create review `step` for a lecture, due from `finishedOn`, and place it. */
function createReview(
  db: Db,
  lectureId: string,
  step: number,
  finishedOn: Temporal.PlainDate,
  previousRating: ReviewRating | null,
  now: Temporal.Instant
): string | null {
  const due = nextDue(finishedOn, step, previousRating)
  if (!due) return null
  const exists = db
    .select()
    .from(t.reviews)
    .where(and(eq(t.reviews.lectureId, lectureId), eq(t.reviews.step, step)))
    .get()
  if (exists) return exists.id
  const id = randomUUID()
  db.insert(t.reviews).values({ id, lectureId, step, due: due.toString() }).run()
  placeReview(db, id, now)
  return id
}

/**
 * Called whenever a block gets an outcome. A finished write-up starts its lecture's reviews;
 * a review block marked done elsewhere (timer, outcome dialog) counts as done with no rating;
 * a skipped review stays open, without a block, so it can be planned again.
 */
export function afterOutcome(db: Db, blockId: string, now: Temporal.Instant): void {
  const block = getBlock(db, blockId)
  if (!block || block.linkedType !== 'lecture' || !block.linkedId) return
  if (block.type === 'write-up' && block.outcome === 'done') {
    const started = db.select().from(t.reviews).where(eq(t.reviews.lectureId, block.linkedId)).get()
    if (!started) createReview(db, block.linkedId, 1, todayLocalDate(now), null, now)
    return
  }
  if (block.type !== 'review') return
  const review = db.select().from(t.reviews).where(eq(t.reviews.blockId, blockId)).get()
  if (!review || review.doneAt) return
  if (block.outcome === 'done' || block.outcome === 'partial') {
    finish(db, review.id, null, now)
  } else if (block.outcome === 'skipped') {
    db.update(t.reviews).set({ blockId: null }).where(eq(t.reviews.id, review.id)).run()
  }
}

function finish(db: Db, reviewId: string, rating: ReviewRating | null, now: Temporal.Instant) {
  const review = db.select().from(t.reviews).where(eq(t.reviews.id, reviewId)).get()!
  db.update(t.reviews)
    .set({ rating, doneAt: toIso(now) })
    .where(eq(t.reviews.id, reviewId))
    .run()
  logChange(db, {
    actor: 'user',
    action: 'review.done',
    entityType: 'review',
    entityId: reviewId,
    after: { rating }
  })
  if (review.step < REVIEW_STEPS) {
    createReview(db, review.lectureId, review.step + 1, todayLocalDate(now), rating, now)
  }
}

/**
 * Finish a guided review: rate it, log the time on its block (if it has one), note it in the
 * lecture's record, and plan the next review from the rating.
 */
export function rateReview(
  db: Db,
  recordsDir: string,
  reviewId: string,
  input: { rating: ReviewRating; minutes?: number },
  now: Temporal.Instant
): void {
  const review = db.select().from(t.reviews).where(eq(t.reviews.id, reviewId)).get()
  if (!review) throw new Error('Review not found.')
  if (review.doneAt) throw new Error('This review is already done.')
  // Rate first, so marking the block done below doesn't finish it a second time.
  finish(db, reviewId, input.rating, now)
  const block = review.blockId ? getBlock(db, review.blockId) : undefined
  if (block && block.outcome === 'none') {
    markOutcome(
      db,
      recordsDir,
      block.id,
      {
        outcome: 'done',
        note: `Review ${review.step}: ${input.rating}`,
        minutes: input.minutes ?? REVIEW_MINUTES
      },
      now
    )
  } else {
    const info = lectureInfo(db, review.lectureId)
    if (info) {
      appendToRecord(
        db,
        recordsDir,
        targetForBlock(db, { linkedType: 'lecture', linkedId: review.lectureId, categoryId: null }),
        `\n- ${zoned(now).toPlainDate().toString()}: review ${review.step} of ${REVIEW_STEPS}, rated ${input.rating}\n`
      )
    }
  }
}

/** Plan an open review again (its block was skipped, or it never found a slot). */
export function rescheduleReview(db: Db, reviewId: string, now: Temporal.Instant): string {
  const review = db.select().from(t.reviews).where(eq(t.reviews.id, reviewId)).get()
  if (!review || review.doneAt) throw new Error('That review is already done.')
  if (review.blockId) {
    const block = getBlock(db, review.blockId)
    if (block && block.outcome === 'none') {
      db.delete(t.blocks).where(eq(t.blocks.id, block.id)).run()
    }
    db.update(t.reviews).set({ blockId: null }).where(eq(t.reviews.id, reviewId)).run()
  }
  const id = placeReview(db, reviewId, now)
  if (!id) throw new Error(`No free ${REVIEW_MINUTES} minutes in the next few days.`)
  return id
}

/** Everything the Revision tab shows. */
export function revisionOverview(db: Db, now: Temporal.Instant): RevisionOverview {
  const today = todayLocalDate(now)
  const modules = new Map(listModules(db).map((m) => [m.id, m]))
  const rows = db
    .select({ review: t.reviews, lecture: t.lectures, title: t.blocks.title })
    .from(t.reviews)
    .innerJoin(t.lectures, eq(t.reviews.lectureId, t.lectures.id))
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .orderBy(asc(t.reviews.due))
    .all()
  const blockIds = rows.map((r) => r.review.blockId).filter((x): x is string => !!x)
  const blocks = new Map(
    (blockIds.length
      ? db.select().from(t.blocks).where(inArray(t.blocks.id, blockIds)).all()
      : []
    ).map((b) => [b.id, b])
  )
  const items: ReviewItem[] = rows.map(({ review, lecture }) => {
    const mod = modules.get(lecture.moduleId)
    const b = review.blockId ? blocks.get(review.blockId) : undefined
    return {
      id: review.id,
      lectureId: lecture.id,
      // "Systems Physiology · L5. Ion channels", as the calendar shows it.
      lectureTitle: `${mod?.name ?? ''} · ${lectureLine(lecture.number, lecture.title)}`,
      moduleId: lecture.moduleId,
      moduleLabel: mod?.shortLabel ?? '',
      colour: mod?.colour ?? '#7b93bd',
      step: review.step,
      steps: REVIEW_STEPS,
      due: review.due,
      status: reviewStatus(review.due, review.doneAt, today),
      block: b
        ? { id: b.id, start: b.start, end: b.end, outcome: b.outcome, attention: b.attention }
        : null,
      rating: review.rating,
      doneAt: review.doneAt
    }
  })

  const week = weekRange(now)
  const inWeek = (iso: string) =>
    Temporal.Instant.compare(Temporal.Instant.from(iso), week.start.toInstant()) >= 0 &&
    Temporal.Instant.compare(Temporal.Instant.from(iso), week.end.toInstant()) < 0

  const byLecture = new Map<string, LectureReviews>()
  for (const r of items) {
    const entry = byLecture.get(r.lectureId) ?? {
      lectureId: r.lectureId,
      // Listed under its module, so just the lecture.
      lectureTitle: lectureLine(
        rows.find((x) => x.lecture.id === r.lectureId)!.lecture.number,
        rows.find((x) => x.lecture.id === r.lectureId)!.lecture.title
      ),
      moduleId: r.moduleId,
      number: rows.find((x) => x.lecture.id === r.lectureId)!.lecture.number,
      reviews: []
    }
    entry.reviews.push(r)
    byLecture.set(r.lectureId, entry)
  }

  return {
    due: items.filter((r) => r.status === 'overdue' || r.status === 'today'),
    week: items
      .filter((r) => !r.doneAt && r.block && inWeek(r.block.start))
      .sort((a, b) => a.block!.start.localeCompare(b.block!.start)),
    lectures: [...byLecture.values()].sort(
      (a, b) => a.moduleId.localeCompare(b.moduleId) || a.number - b.number
    )
  }
}
