import { and, eq, gt, lt, ne } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { findSlot } from '../core/scheduler'
import { atLocalTime, minutesBetween, todayLocalDate, toIso } from '../core/time'
import type { Block, ShutdownSummary } from '../shared/types'
import { writeUpDeadline } from './assistant/placement'
import { scheduleBacklogItem } from './backlog'
import { getAvailability, getBlock, moveBlock } from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { listBlocksInRange } from './repo'
import { markOutcome } from './sessions'

// Evening shutdown: what got done today, what's left, and one action to move the unfinished
// work to the Backlog or reschedule it. Previews tomorrow's first block.

/** How far ahead "reschedule" looks for a slot, from tomorrow morning. */
const RESCHEDULE_DAYS = 7

const isFlexibleWork = (b: Block) => b.kind === 'flexible'

export function shutdownSummary(db: Db, now: Temporal.Instant): ShutdownSummary {
  const today = todayLocalDate(now)
  const start = toIso(atLocalTime(today, '00:00'))
  const end = toIso(atLocalTime(today.add({ days: 1 }), '00:00'))
  const blocks = listBlocksInRange(db, start, end).filter(
    (b) => isFlexibleWork(b) && b.start >= start
  )
  const nowIso = toIso(now)
  const done = blocks.filter((b) => b.outcome === 'done')
  const minutes = db
    .select({ start: t.sessions.start, minutes: t.sessions.minutes })
    .from(t.sessions)
    .where(and(gt(t.sessions.start, start), lt(t.sessions.start, end)))
    .all()
    .reduce((sum, s) => sum + s.minutes, 0)
  const tomorrowStart = end
  const tomorrowEnd = toIso(atLocalTime(today.add({ days: 2 }), '00:00'))
  const tomorrow = listBlocksInRange(db, tomorrowStart, tomorrowEnd).filter(
    (b) => b.start >= tomorrowStart && b.outcome !== 'skipped'
  )
  return {
    done,
    loggedMinutes: minutes,
    // Still to come today and not started.
    left: blocks.filter((b) => b.outcome === 'none' && b.end > nowIso),
    // Over (or half done) and not finished: unmarked, partial, or skipped and not followed up.
    unfinished: blocks.filter(
      (b) =>
        (b.outcome === 'none' && b.end <= nowIso) ||
        ((b.outcome === 'partial' || b.outcome === 'skipped') && !b.backlogResolvedAt)
    ),
    tomorrowFirst: tomorrow[0] ?? null,
    tomorrowFirstWork: tomorrow.find(isFlexibleWork) ?? null
  }
}

/** The first free slot from tomorrow morning, keeping a write-up within its 3 working days if it can. */
function slotFromTomorrow(db: Db, block: Block, minutes: number, now: Temporal.Instant) {
  const from = atLocalTime(todayLocalDate(now).add({ days: 1 }), '00:00').toInstant()
  let until = from.add({ hours: 24 * RESCHEDULE_DAYS })
  if (block.type === 'write-up' && block.linkedType === 'lecture' && block.linkedId) {
    const limit = writeUpDeadline(db, block.linkedId)
    if (limit && Temporal.Instant.compare(Temporal.Instant.from(limit), from) > 0) {
      until = Temporal.Instant.from(limit)
    }
  }
  const busy = db
    .select({ start: t.blocks.start, end: t.blocks.end })
    .from(t.blocks)
    .where(
      and(
        lt(t.blocks.start, toIso(until)),
        gt(t.blocks.end, toIso(from)),
        ne(t.blocks.outcome, 'skipped'),
        ne(t.blocks.id, block.id)
      )
    )
    .all()
  return findSlot({
    from: toIso(from),
    until: toIso(until),
    durationMinutes: minutes,
    busy,
    availability: getAvailability(db)
  })
}

/**
 * Reschedule unfinished work from tomorrow on: unmarked blocks move; partial and skipped ones
 * get a follow-up (as from the Backlog). Returns what couldn't be placed.
 */
export function rescheduleUnfinished(
  db: Db,
  blockIds: string[],
  now: Temporal.Instant
): { moved: number; notPlaced: string[] } {
  let moved = 0
  const notPlaced: string[] = []
  for (const id of blockIds) {
    const block = getBlock(db, id)
    if (!block || block.kind !== 'flexible') continue
    const length = minutesBetween(block.start, block.end)
    const minutes =
      block.outcome === 'partial' ? Math.max(15, Math.ceil(length / 2 / 15) * 15) : length
    const slot = slotFromTomorrow(db, block, minutes, now)
    if (!slot) {
      notPlaced.push(block.title)
      continue
    }
    if (block.outcome === 'none') {
      moveBlock(db, id, slot.start, slot.end, 'user')
      db.update(t.blocks)
        .set({
          attention: slot.withinAvailability
            ? null
            : 'Placed outside your availability: nothing else fitted.'
        })
        .where(eq(t.blocks.id, id))
        .run()
    } else if (block.outcome === 'partial' || block.outcome === 'skipped') {
      scheduleBacklogItem(db, `${block.outcome}:${id}`, { start: slot.start, minutes }, now)
    } else {
      continue
    }
    moved++
  }
  return { moved, notPlaced }
}

/**
 * Send unfinished work to the Backlog: unmarked blocks are marked skipped (partial and skipped
 * ones are there already). Blocks later today show up there once their time has passed.
 */
export function sendToBacklog(
  db: Db,
  recordsDir: string,
  blockIds: string[],
  now: Temporal.Instant
): number {
  let count = 0
  for (const id of blockIds) {
    const block = getBlock(db, id)
    if (!block || block.kind !== 'flexible' || block.outcome !== 'none') continue
    markOutcome(db, recordsDir, id, { outcome: 'skipped' }, now)
    count++
  }
  return count
}
