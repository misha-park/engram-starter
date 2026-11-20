import { Temporal } from 'temporal-polyfill'
import type { AvailabilitySettings } from '../shared/types'
import { availableWindow, noWorkBefore } from './availability'
import { atLocalTime, todayLocalDate, toIso, TZ, weekRange } from './time'

// The scheduling engine: deterministic, pure code that finds free time under constraints.
// Automatic placement (write-ups now; assignment stages in Phase 4) and the assistant's
// tools (Phase 6) all go through here, never through the LLM.

export interface Interval {
  start: string
  end: string
}

export interface Slot extends Interval {
  /** False when the slot had to go outside the availability rules (fallback placement). */
  withinAvailability: boolean
}

/** Placement granularity in minutes: slots start on quarter hours. */
export const STEP_MINUTES = 15

const I = (iso: string) => Temporal.Instant.from(iso)
const cmp = Temporal.Instant.compare
const max = (a: Temporal.Instant, b: Temporal.Instant) => (cmp(a, b) >= 0 ? a : b)
const min = (a: Temporal.Instant, b: Temporal.Instant) => (cmp(a, b) <= 0 ? a : b)

/** Round up to the next step boundary (offsets are whole hours, so UTC steps match local ones). */
export function snapUp(t: Temporal.Instant, step = STEP_MINUTES): Temporal.Instant {
  const ms = step * 60_000
  const rem = t.epochMilliseconds % ms
  return rem === 0 ? t : Temporal.Instant.fromEpochMilliseconds(t.epochMilliseconds - rem + ms)
}

/** Free gaps inside `range` that don't overlap any busy interval, with starts snapped to the step. */
export function freeIntervals(range: Interval, busy: Interval[], step = STEP_MINUTES): Interval[] {
  const rangeStart = I(range.start)
  const rangeEnd = I(range.end)
  const relevant = busy
    .map((b) => ({ start: I(b.start), end: I(b.end) }))
    .filter((b) => cmp(b.end, rangeStart) > 0 && cmp(b.start, rangeEnd) < 0)
    .sort((a, b) => cmp(a.start, b.start))

  const gaps: Interval[] = []
  let cursor = snapUp(rangeStart, step)
  for (const b of relevant) {
    if (cmp(b.start, cursor) > 0) {
      const gapEnd = min(b.start, rangeEnd)
      if (cmp(gapEnd, cursor) > 0) gaps.push({ start: toIso(cursor), end: toIso(gapEnd) })
    }
    cursor = max(cursor, snapUp(b.end, step))
    if (cmp(cursor, rangeEnd) >= 0) break
  }
  if (cmp(rangeEnd, cursor) > 0) gaps.push({ start: toIso(cursor), end: toIso(rangeEnd) })
  return gaps
}

/** The first slot of `durationMinutes` in `range` that avoids `busy`, or null. */
export function firstFit(
  range: Interval,
  durationMinutes: number,
  busy: Interval[]
): Interval | null {
  for (const gap of freeIntervals(range, busy)) {
    const start = I(gap.start)
    const end = start.add({ minutes: durationMinutes })
    if (cmp(end, I(gap.end)) <= 0) return { start: gap.start, end: toIso(end) }
  }
  return null
}

/**
 * When nothing fits inside availability, the "least-bad slot" fallback keeps "no work before"
 * (a hard limit) but lets the day run to midnight, past the working-day end and protected evenings.
 */
export const FALLBACK_DAY_END = '00:00'

/**
 * Find the first slot between `from` and `until`, day by day, inside the availability rules.
 * If nothing fits, try again from "no work before" until midnight, marked as outside availability.
 */
export function findSlot(opts: {
  from: string
  until: string
  durationMinutes: number
  busy: Interval[]
  availability: AvailabilitySettings
}): Slot | null {
  const from = I(opts.from)
  const until = I(opts.until)
  if (cmp(until, from) <= 0) return null
  const firstDay = todayLocalDate(from)
  const lastDay = todayLocalDate(until.subtract({ nanoseconds: 1 }))

  const days: Temporal.PlainDate[] = []
  for (let d = firstDay; Temporal.PlainDate.compare(d, lastDay) <= 0; d = d.add({ days: 1 }))
    days.push(d)

  const attempt = (
    dayWindow: (d: Temporal.PlainDate) => { start: Temporal.Instant; end: Temporal.Instant } | null
  ) => {
    for (const d of days) {
      const w = dayWindow(d)
      if (!w) continue
      const start = max(w.start, from)
      const end = min(w.end, until)
      if (cmp(end, start) <= 0) continue
      const fit = firstFit(
        { start: toIso(start), end: toIso(end) },
        opts.durationMinutes,
        opts.busy
      )
      if (fit) return fit
    }
    return null
  }

  const inside = attempt((d) => {
    const w = availableWindow(opts.availability, d)
    return w ? { start: w.start.toInstant(), end: w.end.toInstant() } : null
  })
  if (inside) return { ...inside, withinAvailability: true }

  const outside = attempt((d) => ({
    start: atLocalTime(d, noWorkBefore(opts.availability, d.dayOfWeek)).toInstant(),
    end: atLocalTime(d.add({ days: 1 }), FALLBACK_DAY_END).toInstant()
  }))
  return outside ? { ...outside, withinAvailability: false } : null
}

/**
 * Write-ups go on the lecture's day if possible, and never later than this many working days
 * (Monday to Friday) after: a Thursday lecture's write-up can still go on the Monday or Tuesday.
 * Weekend days in between can be used too; they just don't count.
 */
export const WRITE_UP_MAX_DAYS_AFTER = 3

/** The latest end for a lecture's write-up: midnight after the 3rd working day after it. */
export function writeUpLimit(lectureEnd: string): Temporal.Instant {
  let day = todayLocalDate(I(lectureEnd))
  for (let working = 0; working < WRITE_UP_MAX_DAYS_AFTER;) {
    day = day.add({ days: 1 })
    if (day.dayOfWeek <= 5) working++
  }
  return atLocalTime(day.add({ days: 1 }), '00:00').toInstant()
}

/**
 * Place a lecture write-up: after the lecture ends, the same day where free time allows,
 * otherwise the next free slot, finishing no later than the end of the 3rd working day after.
 * `now` keeps placement out of the past, unless the whole window is already over
 * (then it is placed historically and shows up as overdue).
 */
export function placeWriteUp(opts: {
  lectureEnd: string
  durationMinutes: number
  busy: Interval[]
  availability: AvailabilitySettings
  now?: string
}): Slot | null {
  const lectureEnd = I(opts.lectureEnd)
  const deadline = writeUpLimit(opts.lectureEnd)
  let from = lectureEnd
  if (opts.now) {
    const now = I(opts.now)
    if (cmp(now, from) > 0 && cmp(now, deadline) < 0) from = now
  }
  return findSlot({
    from: toIso(from),
    until: toIso(deadline),
    durationMinutes: opts.durationMinutes,
    busy: opts.busy,
    availability: opts.availability
  })
}

// --- Move to next week ------------------------------------------------------------------

export interface NextWeekPlacement extends Slot {
  /** True when it kept its day and time (that slot was free). */
  sameTime: boolean
}

/**
 * "Move to next week": the same day and time a week later when that's free, otherwise the first
 * free slot in that Monday–Sunday week (inside availability if possible; "no work before" always
 * holds). Nothing goes before `now` or ends after `limit` (a write-up's 3-working-day limit).
 * Null when nothing legal fits that week. `busy` must leave out the block being moved.
 */
export function placeNextWeek(opts: {
  start: string
  end: string
  busy: Interval[]
  availability: AvailabilitySettings
  now: string
  limit?: string | null
}): NextWeekPlacement | null {
  const start = zonedOf(opts.start).add({ days: 7 }).toInstant()
  const end = zonedOf(opts.end).add({ days: 7 }).toInstant()
  const now = I(opts.now)
  const limit = opts.limit ? I(opts.limit) : null
  const durationMinutes = Math.round(end.since(start).total('minutes'))

  const clashes = opts.busy.some((b) => cmp(I(b.start), end) < 0 && cmp(I(b.end), start) > 0)
  const inTime = cmp(start, now) >= 0 && (!limit || cmp(end, limit) <= 0)
  if (!clashes && inTime)
    return { start: toIso(start), end: toIso(end), withinAvailability: true, sameTime: true }

  const week = weekRange(start)
  const from = max(week.start.toInstant(), now)
  const until = limit ? min(week.end.toInstant(), limit) : week.end.toInstant()
  const slot = findSlot({
    from: toIso(from),
    until: toIso(until),
    durationMinutes,
    busy: opts.busy,
    availability: opts.availability
  })
  return slot ? { ...slot, sameTime: false } : null
}

const zonedOf = (iso: string) => I(iso).toZonedDateTimeISO(TZ)

// --- Back-scheduling (assignments) ------------------------------------------------------

/** Round down to a step boundary. */
export function snapDown(t: Temporal.Instant, step = STEP_MINUTES): Temporal.Instant {
  const ms = step * 60_000
  return Temporal.Instant.fromEpochMilliseconds(t.epochMilliseconds - (t.epochMilliseconds % ms))
}

/** The latest slot of `durationMinutes` in `range` that avoids `busy`, or null. */
export function lastFit(
  range: Interval,
  durationMinutes: number,
  busy: Interval[]
): Interval | null {
  const gaps = freeIntervals(range, busy)
  for (let i = gaps.length - 1; i >= 0; i--) {
    const end = snapDown(I(gaps[i].end))
    const start = end.subtract({ minutes: durationMinutes })
    if (cmp(start, I(gaps[i].start)) >= 0) return { start: toIso(start), end: toIso(end) }
  }
  return null
}

/**
 * The latest slot between `from` and `until`, searching day by day backwards. With
 * `outsideAvailability`, the day runs from "no work before" to midnight instead.
 * `dayAllowed` can veto a day (e.g. a per-day cap).
 */
export function findSlotBackward(opts: {
  from: string
  until: string
  durationMinutes: number
  busy: Interval[]
  availability: AvailabilitySettings
  outsideAvailability?: boolean
  dayAllowed?: (day: Temporal.PlainDate) => boolean
}): Interval | null {
  const from = I(opts.from)
  const until = I(opts.until)
  if (cmp(until, from) <= 0) return null
  const firstDay = todayLocalDate(from)
  for (
    let d = todayLocalDate(until.subtract({ nanoseconds: 1 }));
    Temporal.PlainDate.compare(d, firstDay) >= 0;
    d = d.subtract({ days: 1 })
  ) {
    if (opts.dayAllowed && !opts.dayAllowed(d)) continue
    let w: { start: Temporal.Instant; end: Temporal.Instant } | null
    if (opts.outsideAvailability) {
      w = {
        start: atLocalTime(d, noWorkBefore(opts.availability, d.dayOfWeek)).toInstant(),
        end: atLocalTime(d.add({ days: 1 }), FALLBACK_DAY_END).toInstant()
      }
    } else {
      const aw = availableWindow(opts.availability, d)
      w = aw ? { start: aw.start.toInstant(), end: aw.end.toInstant() } : null
    }
    if (!w) continue
    const start = max(w.start, from)
    const end = min(w.end, until)
    if (cmp(end, start) <= 0) continue
    const fit = lastFit({ start: toIso(start), end: toIso(end) }, opts.durationMinutes, opts.busy)
    if (fit) return fit
  }
  return null
}

/** Assignments aim to be finished this many days before the deadline. */
export const ASSIGNMENT_BUFFER_DAYS = 2
/**
 * Longest single block for assignment work, and the most of one assignment on one day
 * (two full chunks fit in a day).
 */
export const MAX_CHUNK_MINUTES = 90
export const MAX_ASSIGNMENT_MINUTES_PER_DAY = 180

export interface StagePlacement extends Slot {
  stageId: string
  /** Placed inside the 2-day buffer because it didn't fit before it. */
  inBuffer: boolean
}

/** Split a stage's time into near-equal chunks of at most MAX_CHUNK_MINUTES, in 15-minute steps. */
export function chunkMinutes(total: number, maxChunk = MAX_CHUNK_MINUTES): number[] {
  if (total <= 0) return []
  const n = Math.ceil(total / maxChunk)
  const base = Math.ceil(total / n / STEP_MINUTES) * STEP_MINUTES
  const chunks: number[] = []
  let left = total
  while (left > 0) {
    const c = Math.min(base, left)
    chunks.push(c)
    left -= c
  }
  return chunks
}

/**
 * Plan assignment stages backwards from the deadline, aiming to finish ASSIGNMENT_BUFFER_DAYS
 * early. Stages keep their order (stage 1 before stage 2 …), each split into chunks, with at
 * most MAX_ASSIGNMENT_MINUTES_PER_DAY of this assignment on any day.
 *
 * The whole plan is tried under each strategy in turn, and the first that fits everything wins:
 * finish before the buffer inside availability; then allow the buffer; then allow time outside
 * availability (never before "no work before"), first before the buffer, then into it. If none
 * fits everything, the one that leaves least unplaced is used. Nothing is placed before `now`.
 */
export function backSchedule(opts: {
  stages: { id: string; minutes: number }[]
  due: string
  now: string
  busy: Interval[]
  availability: AvailabilitySettings
  /** Minutes of this assignment already planned per local day (kept blocks). */
  plannedPerDay?: Map<string, number>
}): { placements: StagePlacement[]; unplaced: { stageId: string; minutes: number }[] } {
  const due = I(opts.due)
  const target = due.subtract({ hours: 24 * ASSIGNMENT_BUFFER_DAYS })
  const strategies = [
    { limit: target, outside: false },
    { limit: due, outside: false },
    { limit: target, outside: true },
    { limit: due, outside: true }
  ]
  let best: ReturnType<typeof planBackwards> | null = null
  for (const s of strategies) {
    const plan = planBackwards(opts, s.limit, s.outside, target)
    if (plan.unplaced.length === 0) return plan
    const left = (p: typeof plan) => p.unplaced.reduce((sum, u) => sum + u.minutes, 0)
    if (!best || left(plan) < left(best)) best = plan
  }
  return best!
}

function planBackwards(
  opts: Parameters<typeof backSchedule>[0],
  limit: Temporal.Instant,
  allowOutside: boolean,
  target: Temporal.Instant
): { placements: StagePlacement[]; unplaced: { stageId: string; minutes: number }[] } {
  const now = I(opts.now)
  const busy = [...opts.busy]
  const perDay = new Map(opts.plannedPerDay ?? [])
  const placements: StagePlacement[] = []
  const unplaced: { stageId: string; minutes: number }[] = []
  let cursor = limit // later stages are placed first; earlier ones must end before this

  for (const stage of [...opts.stages].reverse()) {
    const chunks = chunkMinutes(stage.minutes)
    for (let i = 0; i < chunks.length; i++) {
      const minutes = chunks[i]
      const dayAllowed = (d: Temporal.PlainDate) =>
        (perDay.get(d.toString()) ?? 0) + minutes <= MAX_ASSIGNMENT_MINUTES_PER_DAY
      const search = (outsideAvailability: boolean) =>
        findSlotBackward({
          from: toIso(now),
          until: toIso(cursor),
          durationMinutes: minutes,
          busy,
          availability: opts.availability,
          outsideAvailability,
          dayAllowed
        })
      let slot = search(false)
      let within = true
      if (!slot && allowOutside) {
        slot = search(true)
        within = false
      }
      if (!slot) {
        // Earlier stages can't go anywhere either (they must come before this one).
        const rest = chunks.slice(i).reduce((s, c) => s + c, 0)
        unplaced.push({ stageId: stage.id, minutes: rest })
        cursor = now // nothing earlier can be placed either
        break
      }
      const placed: StagePlacement = {
        ...slot,
        stageId: stage.id,
        withinAvailability: within,
        inBuffer: cmp(I(slot.end), target) > 0
      }
      placements.push(placed)
      busy.push(placed)
      const day = todayLocalDate(I(placed.start)).toString()
      perDay.set(day, (perDay.get(day) ?? 0) + minutes)
      cursor = min(cursor, I(placed.start))
    }
  }
  placements.sort((a, b) => a.start.localeCompare(b.start))
  // Report unplaced time in stage order.
  const order = new Map(opts.stages.map((s, i) => [s.id, i]))
  unplaced.sort((a, b) => order.get(a.stageId)! - order.get(b.stageId)!)
  return { placements, unplaced }
}
