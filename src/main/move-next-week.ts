import { Temporal } from 'temporal-polyfill'
import { placeNextWeek } from '../core/scheduler'
import { toIso, weekRange, zoned } from '../core/time'
import type { NextWeekMove } from '../shared/types'
import { busyBetween, writeUpDeadline } from './assistant/placement'
import { getAvailability, getBlock, moveBlock } from './calendar'
import type { Db } from './db/client'

/**
 * Right-click → Move to next week: the same time a week later if that's free, otherwise the
 * first free slot that week (`placeNextWeek`). A write-up keeps its 3-working-day limit, so when
 * nothing legal fits it stays put and the reason comes back instead.
 */
export function moveToNextWeek(db: Db, id: string, now: Temporal.Instant): NextWeekMove {
  const block = getBlock(db, id)
  if (!block) throw new Error('Block not found.')
  const week = weekRange(zoned(block.start).add({ days: 7 }).toInstant())
  const limit =
    block.type === 'write-up' && block.linkedType === 'lecture' && block.linkedId
      ? writeUpDeadline(db, block.linkedId)
      : null
  const slot = placeNextWeek({
    start: block.start,
    end: block.end,
    busy: busyBetween(db, toIso(week.start), toIso(week.end), id),
    availability: getAvailability(db),
    now: toIso(now),
    limit
  })
  if (!slot) {
    return {
      moved: false,
      reason:
        limit && Temporal.Instant.compare(Temporal.Instant.from(limit), week.start.toInstant()) <= 0
          ? 'A write-up has to be done within 3 working days of its lecture, so it can’t go to next week.'
          : 'Next week has no free slot long enough.'
    }
  }
  return {
    moved: true,
    block: moveBlock(db, id, slot.start, slot.end, 'user'),
    sameTime: slot.sameTime,
    withinAvailability: slot.withinAvailability
  }
}
