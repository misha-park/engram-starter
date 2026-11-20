import { and, eq, gt, lt, ne } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { availableWindow } from '../../core/availability'
import {
  ASSIGNMENT_BUFFER_DAYS,
  freeIntervals,
  WRITE_UP_MAX_DAYS_AFTER,
  writeUpLimit,
  type Interval
} from '../../core/scheduler'
import { toIso, TZ, zoned } from '../../core/time'
import type { BlockType, LinkedType } from '../../shared/types'
import { getAvailability, LATE_WRITE_UP_NOTE } from '../calendar'
import type { Db } from '../db/client'
import * as t from '../db/schema'

// The hard rules the assistant's placements must follow. The scheduler's automatic fallback
// may go outside availability (and flags it); the assistant may not: it tells the user instead.

const I = (iso: string) => Temporal.Instant.from(iso)
const cmp = Temporal.Instant.compare

/** "2026-11-19T14:00" (London time) → UTC ISO. Also accepts full ISO strings with an offset. */
export function parseLocal(input: string): string {
  const s = input.trim()
  try {
    if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return toIso(Temporal.Instant.from(s))
    return toIso(Temporal.PlainDateTime.from(s).toZonedDateTime(TZ))
  } catch {
    throw new Error(`Couldn’t read the time “${input}”. Use YYYY-MM-DDTHH:mm (London time).`)
  }
}

/** UTC ISO → "2026-11-19T14:00" in London time. */
export function toLocal(iso: string): string {
  return zoned(iso).toPlainDateTime().toString({ smallestUnit: 'minute' })
}

/** "Wed 19 Nov" */
export function dayLabel(iso: string): string {
  return zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Blocks that occupy time (skipped ones don't), optionally leaving one out. */
export function busyBetween(db: Db, startIso: string, endIso: string, exceptId?: string) {
  return db
    .select({ id: t.blocks.id, title: t.blocks.title, start: t.blocks.start, end: t.blocks.end })
    .from(t.blocks)
    .where(
      and(
        lt(t.blocks.start, endIso),
        gt(t.blocks.end, startIso),
        ne(t.blocks.outcome, 'skipped'),
        exceptId ? ne(t.blocks.id, exceptId) : undefined
      )
    )
    .all()
}

/** The latest end a write-up may have: the end of the 3rd working day after its lecture. */
export function writeUpDeadline(db: Db, lectureId: string): string | null {
  const row = db
    .select({ end: t.blocks.end })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .where(eq(t.lectures.id, lectureId))
    .get()
  if (!row) return null
  return toIso(writeUpLimit(row.end))
}

/** The latest end for assignment work: 2 days before the deadline. */
export function stageDeadline(db: Db, stageId: string): { limit: string; due: string } | null {
  const row = db
    .select({ due: t.assignments.due })
    .from(t.assignmentStages)
    .innerJoin(t.assignments, eq(t.assignmentStages.assignmentId, t.assignments.id))
    .where(eq(t.assignmentStages.id, stageId))
    .get()
  if (!row) return null
  return { due: row.due, limit: toIso(I(row.due).subtract({ hours: 24 * ASSIGNMENT_BUFFER_DAYS })) }
}

export interface PlacementInput {
  blockId?: string
  start: string
  end: string
  linkedType?: LinkedType | null
  linkedId?: string | null
  /** Reviews are linked to lectures too, but the write-up limit isn't theirs. */
  type?: BlockType
  /** The user explicitly asked for this time: a write-up may go past its limit (flagged). */
  lateByRequest?: boolean
}

/** The note on a write-up placed past its limit because the user asked for that time. */
export function lateWriteUpNote(limit: string): string {
  return `${LATE_WRITE_UP_NOTE} (end of ${dayLabel(toIso(I(limit).subtract({ minutes: 1 })))}): placed here at your request.`
}

/** When a lecture's write-up placement ends after its (still future) limit, that limit. */
export function pastWriteUpLimit(db: Db, p: PlacementInput, now: Temporal.Instant): string | null {
  if (p.linkedType !== 'lecture' || !p.linkedId || p.type === 'review') return null
  const limit = writeUpDeadline(db, p.linkedId)
  // Once the window is over (overdue work from the Backlog) the limit can't be met: soonest wins.
  if (limit && cmp(I(limit), now) > 0 && cmp(I(p.end), I(limit)) > 0) return limit
  return null
}

/** Every rule a proposed placement breaks, as sentences for Claude (empty = fine). */
export function placementProblems(db: Db, p: PlacementInput, now: Temporal.Instant): string[] {
  const problems: string[] = []
  const start = I(p.start)
  const end = I(p.end)
  if (cmp(end, start) <= 0) return ['The end must be after the start.']
  if (cmp(start, now) < 0) problems.push('That time is in the past.')

  const av = getAvailability(db)
  const day = zoned(p.start).toPlainDate()
  const window = availableWindow(av, day)
  if (!window || cmp(start, window.start.toInstant()) < 0 || cmp(end, window.end.toInstant()) > 0) {
    problems.push(
      window
        ? `Outside availability: on ${dayLabel(p.start)} work fits between ${toLocal(toIso(window.start)).slice(11)} and ${toLocal(toIso(window.end)).slice(11)}.`
        : `No work is allowed on ${dayLabel(p.start)}.`
    )
  }

  const clashes = busyBetween(db, p.start, p.end, p.blockId)
  if (clashes.length > 0) {
    problems.push(
      `Overlaps ${clashes
        .slice(0, 3)
        .map((c) => `“${c.title}” (${toLocal(c.start).slice(11)}–${toLocal(c.end).slice(11)})`)
        .join(', ')}.`
    )
  }

  const limit = p.lateByRequest ? null : pastWriteUpLimit(db, p, now)
  if (limit) {
    problems.push(
      `A write-up must be done within ${WRITE_UP_MAX_DAYS_AFTER} working days of its lecture (by the end of ${dayLabel(toIso(I(limit).subtract({ minutes: 1 })))}). If the user explicitly asked for this time, call again with past_limit_requested: true.`
    )
  }
  if (p.linkedType === 'assignment-stage' && p.linkedId) {
    const d = stageDeadline(db, p.linkedId)
    if (d && cmp(I(d.limit), now) > 0 && cmp(end, I(d.limit)) > 0) {
      problems.push(
        `Assignment work must finish ${ASSIGNMENT_BUFFER_DAYS} days before the deadline (${dayLabel(d.due)} ${toLocal(d.due).slice(11)}), so by ${dayLabel(d.limit)} ${toLocal(d.limit).slice(11)}.`
      )
    }
  }
  return problems
}

/** Free time inside availability on each day from `from` to `to` (local dates, inclusive). */
export function freeSlots(
  db: Db,
  opts: { from: string; to: string; minutes: number; exceptBlockId?: string },
  now: Temporal.Instant
): { day: string; date: string; slots: { start: string; end: string; minutes: number }[] }[] {
  const av = getAvailability(db)
  const first = Temporal.PlainDate.from(opts.from)
  const last = Temporal.PlainDate.from(opts.to)
  if (Temporal.PlainDate.compare(last, first) < 0) throw new Error('“to” is before “from”.')
  if (first.until(last).days > 31) throw new Error('Look at most a month at a time.')

  const out: ReturnType<typeof freeSlots> = []
  for (let d = first; Temporal.PlainDate.compare(d, last) <= 0; d = d.add({ days: 1 })) {
    const w = availableWindow(av, d)
    if (!w) continue
    let start = w.start.toInstant()
    const end = w.end.toInstant()
    if (cmp(start, now) < 0) start = now
    if (cmp(end, start) <= 0) continue
    const range: Interval = { start: toIso(start), end: toIso(end) }
    const busy = busyBetween(db, range.start, range.end, opts.exceptBlockId)
    const slots = freeIntervals(range, busy)
      .map((g) => ({
        start: toLocal(g.start),
        end: toLocal(g.end),
        minutes: Math.round(I(g.start).until(I(g.end)).total({ unit: 'minutes' }))
      }))
      .filter((g) => g.minutes >= opts.minutes)
    if (slots.length) {
      out.push({ day: dayLabel(toIso(w.start)), date: d.toString(), slots })
    }
  }
  return out
}
