import { Temporal } from 'temporal-polyfill'
import { instant, minutesBetween, startOfDay, weekRange, type Instant } from './time'

interface Interval {
  start: string
  end: string | null
}

/** Minutes of `interval` that fall inside [rangeStart, rangeEnd). Open intervals count up to `now`. */
export function overlapMinutes(
  interval: Interval,
  rangeStart: Instant,
  rangeEnd: Instant,
  now: Instant
): number {
  const s = instant(interval.start)
  const e = interval.end ? instant(interval.end) : now
  const from = Temporal.Instant.compare(s, rangeStart) > 0 ? s : rangeStart
  const to = Temporal.Instant.compare(e, rangeEnd) < 0 ? e : rangeEnd
  return Temporal.Instant.compare(to, from) > 0 ? minutesBetween(from, to) : 0
}

/**
 * Self-study minutes in the Monday–Sunday week containing `now`.
 * Sessions only ever come from flexible blocks or manual entries, so timetabled teaching
 * is excluded by construction.
 */
export function weekStudyMinutes(sessions: Interval[], now: Instant): number {
  const { start, end } = weekRange(now)
  return sessions.reduce(
    (sum, s) => sum + overlapMinutes(s, start.toInstant(), end.toInstant(), now),
    0
  )
}

interface PlannedBlock {
  start: string
  end: string
  kind: 'fixed' | 'flexible'
  outcome: string
}

/** Minutes left today in unfinished flexible blocks (the part of each that is still ahead). */
export function remainingTodayMinutes(blocks: PlannedBlock[], now: Instant): number {
  const dayEnd = startOfDay(now).add({ days: 1 }).toInstant()
  return blocks
    .filter((b) => b.kind === 'flexible' && b.outcome === 'none')
    .reduce((sum, b) => sum + overlapMinutes(b, now, dayEnd, now), 0)
}

/** Minutes logged today (local day containing `now`); a running session counts up to now. */
export function workedTodayMinutes(sessions: Interval[], now: Instant): number {
  const dayStart = startOfDay(now)
  const dayEnd = dayStart.add({ days: 1 }).toInstant()
  return sessions.reduce((sum, s) => sum + overlapMinutes(s, dayStart.toInstant(), dayEnd, now), 0)
}

/**
 * Continuous work up to now: only while a session is running. Earlier sessions that end
 * within `gapMinutes` of the next one join the same stretch (a short pause isn't a break).
 */
export function unbrokenMinutes(sessions: Interval[], now: Instant, gapMinutes = 10): number {
  const running = sessions.find((s) => s.end === null)
  if (!running) return 0
  let stretchStart = instant(running.start)
  const finished = sessions
    .filter((s) => s.end !== null && Temporal.Instant.compare(instant(s.end), stretchStart) <= 0)
    .sort((a, b) => b.end!.localeCompare(a.end!))
  for (const s of finished) {
    const gap = minutesBetween(s.end!, stretchStart)
    if (gap > gapMinutes) break
    if (Temporal.Instant.compare(instant(s.start), stretchStart) < 0)
      stretchStart = instant(s.start)
  }
  return minutesBetween(stretchStart, now)
}
