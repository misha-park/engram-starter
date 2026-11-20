import { and, eq, gt, lt } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { availableWindow } from '../../core/availability'
import { minutesBetween, toIso, TZ } from '../../core/time'
import { createBlock, getAvailability, getBlock, moveBlock } from '../calendar'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import {
  dayLabel,
  freeSlots,
  parseLocal,
  placementProblems,
  stageDeadline,
  toLocal,
  writeUpDeadline
} from './placement'

// Time off ("I'm ill, clear Thursday"): each day gets a fixed "Time off" block over its
// available hours, so nothing is placed there later, and the flexible work on those days
// moves to the first time that follows every placement rule. Work that can't move within
// its limit stays where it is and is reported, for Claude to ask the user about.

const MAX_DAYS = 14
/** How far ahead moved work may go. */
const SEARCH_DAYS = 21

const I = (iso: string) => Temporal.Instant.from(iso)

export interface TimeOffResult {
  timeOff: { blockId: string; day: string; from: string; to: string }[]
  moved: { blockId: string; title: string; from: string; to: string }[]
  notMoved: { blockId: string; title: string; at: string; why: string }[]
}

/** The latest end a block's work may have (write-up or assignment limit), if it has one. */
function limitOf(db: Db, b: { linkedType: string | null; linkedId: string | null; type: string }) {
  if (b.linkedType === 'lecture' && b.linkedId && b.type !== 'review') {
    return writeUpDeadline(db, b.linkedId)
  }
  if (b.linkedType === 'assignment-stage' && b.linkedId) {
    return stageDeadline(db, b.linkedId)?.limit ?? null
  }
  return null
}

export function takeTimeOff(
  db: Db,
  opts: { from: string; to: string; title?: string },
  now: Temporal.Instant
): TimeOffResult {
  const first = Temporal.PlainDate.from(opts.from)
  const last = Temporal.PlainDate.from(opts.to)
  if (Temporal.PlainDate.compare(last, first) < 0) throw new Error('“to” is before “from”.')
  if (first.until(last).days + 1 > MAX_DAYS) throw new Error(`At most ${MAX_DAYS} days at a time.`)
  const title = opts.title?.trim() || 'Time off'
  const av = getAvailability(db)

  const result: TimeOffResult = { timeOff: [], moved: [], notMoved: [] }
  const toMove = new Map<string, typeof t.blocks.$inferSelect>()

  for (let d = first; Temporal.PlainDate.compare(d, last) <= 0; d = d.add({ days: 1 })) {
    const dayStart = d.toZonedDateTime({ timeZone: TZ }).toInstant()
    const dayEnd = d.add({ days: 1 }).toZonedDateTime({ timeZone: TZ }).toInstant()
    if (Temporal.Instant.compare(dayEnd, now) <= 0) continue

    const w = availableWindow(av, d)
    if (w) {
      const start =
        Temporal.Instant.compare(w.start.toInstant(), now) > 0 ? w.start.toInstant() : now
      const end = w.end.toInstant()
      if (Temporal.Instant.compare(end, start) > 0) {
        const block = createBlock(
          db,
          {
            title,
            start: toIso(start),
            end: toIso(end),
            kind: 'fixed',
            moduleId: null,
            notes: 'Added by Claude so nothing is planned here. Delete it to free the time again.'
          },
          'claude'
        )
        result.timeOff.push({
          blockId: block.id,
          day: dayLabel(block.start),
          from: toLocal(block.start).slice(11),
          to: toLocal(block.end).slice(11)
        })
      }
    }

    // Flexible work not started yet, anywhere on that day.
    const later = Temporal.Instant.compare(dayStart, now) > 0 ? dayStart : now
    for (const b of db
      .select()
      .from(t.blocks)
      .where(
        and(
          eq(t.blocks.kind, 'flexible'),
          eq(t.blocks.outcome, 'none'),
          lt(t.blocks.start, toIso(dayEnd)),
          gt(t.blocks.start, toIso(later))
        )
      )
      .all()) {
      toMove.set(b.id, b)
    }
  }

  // Work with the nearest limit gets first pick of the free time.
  const queue = [...toMove.values()]
    .map((b) => ({ b, limit: limitOf(db, b) }))
    .sort(
      (x, y) =>
        (x.limit ?? '9999').localeCompare(y.limit ?? '9999') || x.b.start.localeCompare(y.b.start)
    )

  const searchFrom = now.toZonedDateTimeISO(TZ).toPlainDate()
  const searchTo = searchFrom.add({ days: SEARCH_DAYS })

  for (const { b, limit } of queue) {
    const minutes = minutesBetween(b.start, b.end)
    const placement = (start: string) => ({
      blockId: b.id,
      start,
      end: toIso(I(start).add({ minutes })),
      linkedType: b.linkedType,
      linkedId: b.linkedId,
      type: b.type
    })
    let found: string | null = null
    outer: for (const day of freeSlots(
      db,
      { from: searchFrom.toString(), to: searchTo.toString(), minutes, exceptBlockId: b.id },
      now
    )) {
      for (const slot of day.slots) {
        const start = parseLocal(slot.start)
        if (placementProblems(db, placement(start), now).length === 0) {
          found = start
          break outer
        }
      }
    }
    if (!found) {
      result.notMoved.push({
        blockId: b.id,
        title: b.title,
        at: toLocal(b.start),
        why: limit
          ? `nothing free before its limit (end of ${dayLabel(toIso(I(limit).subtract({ minutes: 1 })))})`
          : `nothing free in the next ${SEARCH_DAYS} days`
      })
      continue
    }
    const p = placement(found)
    moveBlock(db, b.id, p.start, p.end, 'claude')
    db.update(t.blocks).set({ attention: null }).where(eq(t.blocks.id, b.id)).run()
    const moved = getBlock(db, b.id)!
    result.moved.push({
      blockId: b.id,
      title: b.title,
      from: toLocal(b.start),
      to: toLocal(moved.start)
    })
  }
  return result
}
