import { and, isNotNull, lt } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import {
  estimateAccuracy,
  plannedVsActual,
  rangeStart,
  sumBy,
  weeklyTotals,
  type StatSession
} from '../core/stats'
import { atLocalTime, startOfWeek, toIso } from '../core/time'
import type { StatsOverview, StatsRange } from '../shared/types'
import type { Db } from './db/client'
import * as t from './db/schema'
import { getSetting } from './repo'

// The Stats page (Phase 9): hours per module and per session type, weekly totals against the
// target, planned vs actual time, and how good assignment estimates were.

const WEEKS_SHOWN = 12

export function statsOverview(db: Db, range: StatsRange, now: Temporal.Instant): StatsOverview {
  const from = rangeStart(range, now)
  const fromIso = from ? toIso(atLocalTime(from, '00:00')) : ''
  const nowIso = toIso(now)

  // What each session was for: its block, or else what it was linked to.
  const blocks = new Map(
    db
      .select()
      .from(t.blocks)
      .all()
      .map((b) => [b.id, b])
  )
  const lectureModule = new Map(
    db
      .select({ id: t.lectures.id, moduleId: t.lectures.moduleId })
      .from(t.lectures)
      .all()
      .map((l) => [l.id, l.moduleId])
  )
  const moduleCategory = new Map(
    db
      .select({ id: t.modules.id, categoryId: t.modules.categoryId })
      .from(t.modules)
      .all()
      .map((m) => [m.id, m.categoryId])
  )
  const assignments = new Map(
    db
      .select()
      .from(t.assignments)
      .all()
      .map((a) => [a.id, a])
  )
  const stages = db.select().from(t.assignmentStages).all()
  const stageAssignment = new Map(stages.map((s) => [s.id, s.assignmentId]))
  const dissModule = db
    .select({ moduleId: t.dissertation.moduleId })
    .from(t.dissertation)
    .get()?.moduleId

  const rows = db
    .select()
    .from(t.sessions)
    .where(and(isNotNull(t.sessions.end), lt(t.sessions.start, nowIso)))
    .all()
  const resolved = rows.map((s) => {
    const block = s.blockId ? blocks.get(s.blockId) : undefined
    const linkedType = s.linkedType ?? block?.linkedType ?? null
    const linkedId = s.linkedId ?? block?.linkedId ?? null
    let categoryId = block?.categoryId ?? null
    let type: string = block?.type ?? 'other'
    if (!block) {
      if (linkedType === 'lecture' && linkedId) {
        categoryId = moduleCategory.get(lectureModule.get(linkedId) ?? '') ?? null
        type = 'write-up'
      } else if (linkedType === 'assignment-stage' && linkedId) {
        const a = assignments.get(stageAssignment.get(linkedId) ?? '')
        categoryId = a ? (moduleCategory.get(a.moduleId) ?? null) : null
        type = 'assignment-stage'
      } else if (linkedType === 'module' && linkedId) {
        categoryId = moduleCategory.get(linkedId) ?? null
      } else if (linkedType === 'dissertation-section') {
        categoryId = dissModule ? (moduleCategory.get(dissModule) ?? null) : null
        type = 'dissertation'
      }
    }
    return {
      session: { start: s.start, minutes: s.minutes, categoryId, type } as StatSession,
      blockId: s.blockId,
      stageId: linkedType === 'assignment-stage' ? linkedId : null
    }
  })
  const inRange = resolved.filter((r) => r.session.start >= fromIso).map((r) => r.session)

  const categories = new Map(
    db
      .select()
      .from(t.categories)
      .all()
      .map((c) => [c.id, c])
  )
  const total = inRange.reduce((sum, s) => sum + s.minutes, 0)
  const thisWeek = startOfWeek(now).toPlainDate()
  const weeksInRange = from ? from.until(thisWeek).days / 7 + 1 : null
  const first = resolved.map((r) => r.session.start).sort()[0]
  const weeksAll = first
    ? startOfWeek(Temporal.Instant.from(first)).toPlainDate().until(thisWeek).days / 7 + 1
    : 1

  // Planned flexible work that has ended, in the range, and the time logged on it.
  const loggedOnBlock = new Map<string, number>()
  for (const r of resolved) {
    if (r.blockId)
      loggedOnBlock.set(r.blockId, (loggedOnBlock.get(r.blockId) ?? 0) + r.session.minutes)
  }
  const ended = [...blocks.values()].filter(
    (b) => b.kind === 'flexible' && b.end <= nowIso && b.start >= fromIso
  )

  // Finished stages (all time): estimate vs logged.
  const loggedOnStage = new Map<string, number>()
  for (const r of resolved) {
    if (r.stageId)
      loggedOnStage.set(r.stageId, (loggedOnStage.get(r.stageId) ?? 0) + r.session.minutes)
  }

  return {
    range,
    from: from?.toString() ?? null,
    totalMinutes: total,
    weekTargetMinutes: getSetting<number>(db, 'weeklyTargetMinutes'),
    averagePerWeek: Math.round(total / Math.max(1, weeksInRange ?? weeksAll)),
    byModule: sumBy(inRange, (s) => s.categoryId).map(({ key, minutes }) => {
      const c = key ? categories.get(key) : undefined
      return {
        categoryId: key,
        label: c ? c.shortLabel : 'Other',
        name: c ? c.name : 'Not linked to a module',
        colour: c?.colour ?? null,
        minutes
      }
    }),
    byType: sumBy(inRange, (s) => s.type).map(({ key, minutes }) => ({ type: key, minutes })),
    weeks: weeklyTotals(
      resolved.map((r) => r.session),
      thisWeek,
      WEEKS_SHOWN
    ),
    planned: plannedVsActual(
      ended.map((b) => ({
        start: b.start,
        end: b.end,
        outcome: b.outcome,
        logged: loggedOnBlock.get(b.id) ?? 0
      }))
    ),
    estimates: estimateAccuracy(
      stages
        .filter((s) => s.doneAt)
        .map((s) => ({
          assignment: assignments.get(s.assignmentId)?.title ?? '',
          stage: s.name,
          estimate: s.estimateMinutes,
          logged: loggedOnStage.get(s.id) ?? 0
        }))
    )
  }
}
