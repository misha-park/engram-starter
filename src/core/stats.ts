// The Stats page (Phase 9): pure sums over logged sessions and planned blocks.

import { Temporal } from 'temporal-polyfill'
import { startOfWeek, TZ } from './time'

/** A logged session with what it was for (resolved by the caller). */
export interface StatSession {
  start: string
  minutes: number
  categoryId: string | null
  /** The block type it was logged against (or the kind of thing it was linked to). */
  type: string
}

/** A planned piece of flexible work that has ended. */
export interface StatBlock {
  start: string
  end: string
  outcome: 'none' | 'done' | 'partial' | 'skipped'
  /** Minutes logged against this block. */
  logged: number
}

/** A finished assignment stage: its estimate and the time logged on it. */
export interface StatStage {
  assignment: string
  stage: string
  estimate: number
  logged: number
}

export const sumBy = <K extends string | null>(
  sessions: StatSession[],
  key: (s: StatSession) => K
): { key: K; minutes: number }[] => {
  const totals = new Map<K, number>()
  for (const s of sessions) totals.set(key(s), (totals.get(key(s)) ?? 0) + s.minutes)
  return [...totals.entries()]
    .map(([k, minutes]) => ({ key: k, minutes }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
}

/** Minutes logged per week (Monday start), oldest first, including empty weeks. */
export function weeklyTotals(
  sessions: StatSession[],
  lastWeekStart: Temporal.PlainDate,
  weeks: number
): { weekStart: string; minutes: number }[] {
  const out = Array.from({ length: weeks }, (_, i) => ({
    weekStart: lastWeekStart.subtract({ weeks: weeks - 1 - i }).toString(),
    minutes: 0
  }))
  const index = new Map(out.map((w, i) => [w.weekStart, i]))
  for (const s of sessions) {
    const week = startOfWeek(Temporal.Instant.from(s.start)).toPlainDate().toString()
    const i = index.get(week)
    if (i !== undefined) out[i].minutes += s.minutes
  }
  return out
}

/** Planned vs done for flexible work that has ended. */
export function plannedVsActual(blocks: StatBlock[]) {
  const planned = blocks.reduce(
    (sum, b) =>
      sum + Temporal.Instant.from(b.start).until(Temporal.Instant.from(b.end)).total('minutes'),
    0
  )
  const logged = blocks.reduce((sum, b) => sum + b.logged, 0)
  const count = (o: StatBlock['outcome']) => blocks.filter((b) => b.outcome === o).length
  return {
    plannedMinutes: Math.round(planned),
    loggedMinutes: logged,
    blocks: blocks.length,
    done: count('done'),
    partial: count('partial'),
    skipped: count('skipped'),
    unmarked: count('none')
  }
}

/**
 * How good the estimates were, over finished stages: logged ÷ estimate overall (1 = spot on,
 * above 1 = took longer than planned) and the stages furthest off.
 */
export function estimateAccuracy(stages: StatStage[]) {
  const timed = stages.filter((s) => s.estimate > 0 && s.logged > 0)
  const estimate = timed.reduce((sum, s) => sum + s.estimate, 0)
  const logged = timed.reduce((sum, s) => sum + s.logged, 0)
  return {
    stages: timed.length,
    ratio: estimate ? logged / estimate : null,
    furthestOff: [...timed]
      .map((s) => ({ ...s, ratio: s.logged / s.estimate }))
      .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
      .slice(0, 5)
  }
}

/** The local date a range starts on: this week, the last 4 or 12 weeks, or all time. */
export function rangeStart(
  range: 'week' | '4w' | '12w' | 'all',
  now: Temporal.Instant
): Temporal.PlainDate | null {
  const thisWeek = startOfWeek(now).toPlainDate()
  if (range === 'week') return thisWeek
  if (range === '4w') return thisWeek.subtract({ weeks: 3 })
  if (range === '12w') return thisWeek.subtract({ weeks: 11 })
  return null
}

export const localDate = (iso: string) =>
  Temporal.Instant.from(iso).toZonedDateTimeISO(TZ).toPlainDate()
