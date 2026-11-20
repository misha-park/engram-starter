import { randomUUID } from 'crypto'
import { and, asc, eq, gt, inArray, lt, ne } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import {
  ASSIGNMENT_TYPES,
  type AssignmentDetail,
  type AssignmentInput,
  type AssignmentSummary,
  type AssignmentUpdate,
  type StageDetail
} from '../shared/types'
import { assignmentStatus, templateStages } from '../core/assignments'
import { backSchedule, type Interval } from '../core/scheduler'
import { minutesBetween, toIso, todayLocalDate } from '../core/time'
import { nextFreeSlot } from './backlog'
import { getAvailability, logChange } from './calendar'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'

// Assignments: records, stages and back-scheduled stage blocks.
//
// `rescheduleAssignment` is the one place stage blocks are (re)planned. It runs after every
// change (create, due date, stages, done, submitted) and is idempotent: it drops the future
// blocks nobody has touched and plans what's left of each unfinished stage, backwards from
// the deadline, aiming to finish 2 days early. Hand-moved and finished blocks are kept.

const OUTSIDE_AVAILABILITY = 'Placed outside your availability to fit before the deadline.'

function validate(input: Partial<AssignmentInput> & AssignmentUpdate): void {
  if (input.title !== undefined && !input.title.trim())
    throw new Error('An assignment needs a title.')
  if (input.type !== undefined && !ASSIGNMENT_TYPES.includes(input.type))
    throw new Error('Invalid type.')
  if (input.due !== undefined) {
    try {
      Temporal.Instant.from(input.due)
    } catch {
      throw new Error('Invalid due date.')
    }
  }
  if (
    input.weighting != null &&
    (!Number.isInteger(input.weighting) || input.weighting < 0 || input.weighting > 100)
  ) {
    throw new Error('Weighting must be between 0 and 100%.')
  }
  if (
    input.mark != null &&
    !(Number.isFinite(input.mark) && input.mark >= 0 && input.mark <= 100)
  ) {
    throw new Error('A mark must be between 0 and 100%.')
  }
  if (input.wordLimit != null && (!Number.isInteger(input.wordLimit) || input.wordLimit < 0)) {
    throw new Error('Invalid word limit.')
  }
  if (input.briefLink && !/^(https?:\/\/|file:\/\/|\/)/.test(input.briefLink)) {
    throw new Error('The brief link must be a web address or a file path.')
  }
  if (
    input.estimateMinutes !== undefined &&
    (!Number.isInteger(input.estimateMinutes) ||
      input.estimateMinutes < 15 ||
      input.estimateMinutes > 200 * 60)
  ) {
    throw new Error('The estimate must be between 15 minutes and 200 hours.')
  }
}

export function createAssignment(db: Db, input: AssignmentInput, now: Temporal.Instant): string {
  validate(input)
  input.stages?.forEach(validateStage)
  const module = db.select().from(t.modules).where(eq(t.modules.id, input.moduleId)).get()
  if (!module) throw new Error('Module not found.')
  const id = randomUUID()
  db.transaction((tx) => {
    tx.insert(t.assignments)
      .values({
        id,
        moduleId: input.moduleId,
        title: input.title.trim(),
        due: toIso(Temporal.Instant.from(input.due)),
        type: input.type,
        weighting: input.weighting ?? null,
        wordLimit: input.wordLimit ?? null,
        briefLink: input.briefLink?.trim() || null,
        isGroup: input.isGroup ?? false,
        notes: input.notes?.trim() || null,
        summary: input.summary?.trim() || null,
        planned: input.planned ?? true
      })
      .run()
    const stages = input.stages?.length
      ? input.stages.map((s) => ({ name: s.name.trim(), minutes: s.estimateMinutes }))
      : templateStages(input.type, input.estimateMinutes)
    stages.forEach((s, i) => {
      tx.insert(t.assignmentStages)
        .values({
          id: randomUUID(),
          assignmentId: id,
          position: i,
          name: s.name,
          estimateMinutes: s.minutes
        })
        .run()
    })
    logChange(tx, {
      actor: 'user',
      action: 'assignment.create',
      entityType: 'assignment',
      entityId: id,
      after: input
    })
  })
  rescheduleAssignment(db, id, now)
  return id
}

export function updateAssignment(
  db: Db,
  id: string,
  patch: AssignmentUpdate,
  now: Temporal.Instant
): void {
  validate(patch)
  const before = db.select().from(t.assignments).where(eq(t.assignments.id, id)).get()
  if (!before) throw new Error('Assignment not found.')
  const values: Partial<typeof t.assignments.$inferInsert> = {}
  if (patch.title !== undefined) values.title = patch.title.trim()
  if (patch.due !== undefined) values.due = toIso(Temporal.Instant.from(patch.due))
  if (patch.type !== undefined) values.type = patch.type
  if (patch.weighting !== undefined) values.weighting = patch.weighting
  if (patch.wordLimit !== undefined) values.wordLimit = patch.wordLimit
  if (patch.briefLink !== undefined) values.briefLink = patch.briefLink?.trim() || null
  if (patch.summary !== undefined) values.summary = patch.summary?.trim().slice(0, 2000) || null
  if (patch.isGroup !== undefined) values.isGroup = patch.isGroup
  if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null
  if (patch.mark !== undefined) values.mark = patch.mark
  if (patch.feedback !== undefined) values.feedback = patch.feedback?.trim() || null
  db.update(t.assignments).set(values).where(eq(t.assignments.id, id)).run()
  logChange(db, {
    actor: 'user',
    action: 'assignment.update',
    entityType: 'assignment',
    entityId: id,
    before,
    after: values
  })
  // A new due date replans the stages to match; a new name renames their blocks.
  if ((values.due && values.due !== before.due) || (values.title && values.title !== before.title))
    rescheduleAssignment(db, id, now)
}

export function setSubmitted(db: Db, id: string, submitted: boolean, now: Temporal.Instant): void {
  const a = db.select().from(t.assignments).where(eq(t.assignments.id, id)).get()
  if (!a) throw new Error('Assignment not found.')
  db.update(t.assignments)
    .set({ submittedAt: submitted ? toIso(now) : null })
    .where(eq(t.assignments.id, id))
    .run()
  logChange(db, {
    actor: 'user',
    action: submitted ? 'assignment.submit' : 'assignment.unsubmit',
    entityType: 'assignment',
    entityId: id
  })
  rescheduleAssignment(db, id, now)
}

/** Delete an assignment and its untouched future blocks (finished work stays on the calendar). */
export function deleteAssignment(db: Db, id: string, now: Temporal.Instant): void {
  const stageIds = stagesOf(db, id).map((s) => s.id)
  db.transaction((tx) => {
    dropUntouchedFutureBlocks(tx, stageIds, now)
    if (stageIds.length) {
      tx.update(t.blocks)
        .set({ linkedType: null, linkedId: null })
        .where(inArray(t.blocks.linkedId, stageIds))
        .run()
    }
    tx.delete(t.assignments).where(eq(t.assignments.id, id)).run()
    logChange(tx, {
      actor: 'user',
      action: 'assignment.delete',
      entityType: 'assignment',
      entityId: id
    })
  })
}

// --- Stages --------------------------------------------------------------------------------

const stagesOf = (db: DbOrTx, assignmentId: string) =>
  db
    .select()
    .from(t.assignmentStages)
    .where(eq(t.assignmentStages.assignmentId, assignmentId))
    .orderBy(asc(t.assignmentStages.position))
    .all()

function validateStage(patch: { name?: string; estimateMinutes?: number }): void {
  if (patch.name !== undefined && !patch.name.trim()) throw new Error('A stage needs a name.')
  if (
    patch.estimateMinutes !== undefined &&
    (!Number.isInteger(patch.estimateMinutes) ||
      patch.estimateMinutes < 15 ||
      patch.estimateMinutes > 100 * 60)
  ) {
    throw new Error('A stage estimate must be between 15 minutes and 100 hours.')
  }
}

export function addStage(
  db: Db,
  assignmentId: string,
  stage: { name: string; estimateMinutes: number },
  now: Temporal.Instant
): string {
  validateStage(stage)
  const stages = stagesOf(db, assignmentId)
  const id = randomUUID()
  db.insert(t.assignmentStages)
    .values({
      id,
      assignmentId,
      position: stages.length,
      name: stage.name.trim(),
      estimateMinutes: stage.estimateMinutes
    })
    .run()
  rescheduleAssignment(db, assignmentId, now)
  return id
}

/**
 * Put one block of a stage's work in the next free slot (e.g. just 3 hours of it), whether or
 * not the assignment is planned. It counts as placed by hand, so replanning leaves it be.
 */
export function addStageBlock(
  db: Db,
  stageId: string,
  minutes: number,
  now: Temporal.Instant
): { id: string; start: string } {
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 8 * 60)
    throw new Error('A block is 15 minutes to 8 hours.')
  const stage = db.select().from(t.assignmentStages).where(eq(t.assignmentStages.id, stageId)).get()
  if (!stage) throw new Error('Stage not found.')
  const a = db.select().from(t.assignments).where(eq(t.assignments.id, stage.assignmentId)).get()!
  const module = db
    .select({ categoryId: t.modules.categoryId })
    .from(t.modules)
    .where(eq(t.modules.id, a.moduleId))
    .get()
  const slot = nextFreeSlot(db, minutes, now)
  const id = `as-${randomUUID().slice(0, 12)}`
  db.transaction((tx) => {
    tx.insert(t.blocks)
      .values({
        id,
        kind: 'flexible',
        type: 'assignment-stage',
        title: `${stage.name} · ${a.title}`,
        start: slot.start,
        end: slot.end,
        categoryId: module?.categoryId ?? null,
        linkedType: 'assignment-stage',
        linkedId: stageId,
        source: 'user',
        detached: true
      })
      .run()
    logChange(tx, {
      actor: 'user',
      action: 'assignment.addBlock',
      entityType: 'block',
      entityId: id,
      after: { stageId, start: slot.start, minutes }
    })
  })
  // A planned assignment's other blocks shrink to match.
  rescheduleAssignment(db, a.id, now)
  return { id, start: slot.start }
}

export function updateStage(
  db: Db,
  stageId: string,
  patch: { name?: string; estimateMinutes?: number; done?: boolean },
  now: Temporal.Instant
): void {
  validateStage(patch)
  const stage = db.select().from(t.assignmentStages).where(eq(t.assignmentStages.id, stageId)).get()
  if (!stage) throw new Error('Stage not found.')
  const values: Partial<typeof t.assignmentStages.$inferInsert> = {}
  if (patch.name !== undefined) values.name = patch.name.trim()
  if (patch.estimateMinutes !== undefined) values.estimateMinutes = patch.estimateMinutes
  if (patch.done !== undefined) values.doneAt = patch.done ? (stage.doneAt ?? toIso(now)) : null
  db.update(t.assignmentStages).set(values).where(eq(t.assignmentStages.id, stageId)).run()
  // Renaming changes block titles; anything else changes the plan.
  rescheduleAssignment(db, stage.assignmentId, now)
}

export function removeStage(db: Db, stageId: string, now: Temporal.Instant): void {
  const stage = db.select().from(t.assignmentStages).where(eq(t.assignmentStages.id, stageId)).get()
  if (!stage) throw new Error('Stage not found.')
  db.transaction((tx) => {
    dropUntouchedFutureBlocks(tx, [stageId], now)
    tx.update(t.blocks)
      .set({ linkedType: null, linkedId: null })
      .where(eq(t.blocks.linkedId, stageId))
      .run()
    tx.delete(t.assignmentStages).where(eq(t.assignmentStages.id, stageId)).run()
    stagesOf(tx, stage.assignmentId).forEach((s, i) =>
      tx
        .update(t.assignmentStages)
        .set({ position: i })
        .where(eq(t.assignmentStages.id, s.id))
        .run()
    )
  })
  rescheduleAssignment(db, stage.assignmentId, now)
}

/**
 * Replace the stages nobody has started (not done, no time logged) with `stages`, keeping the
 * started ones first. A new stage with the same name as a kept one is skipped. Used when an
 * assignment is planned from its brief.
 */
export function replaceOpenStages(
  db: Db,
  assignmentId: string,
  stages: { name: string; estimateMinutes: number }[],
  now: Temporal.Instant
): void {
  stages.forEach(validateStage)
  db.transaction((tx) => {
    const current = stagesOf(tx, assignmentId)
    const logged = loggedByStage(
      tx,
      current.map((s) => s.id)
    )
    const kept = current.filter((s) => s.doneAt || logged.has(s.id))
    const dropped = current.filter((s) => !kept.includes(s)).map((s) => s.id)
    dropUntouchedFutureBlocks(tx, dropped, now)
    if (dropped.length) {
      tx.update(t.blocks)
        .set({ linkedType: null, linkedId: null })
        .where(
          and(eq(t.blocks.linkedType, 'assignment-stage'), inArray(t.blocks.linkedId, dropped))
        )
        .run()
      tx.delete(t.assignmentStages).where(inArray(t.assignmentStages.id, dropped)).run()
    }
    kept.forEach((s, i) =>
      tx
        .update(t.assignmentStages)
        .set({ position: i })
        .where(eq(t.assignmentStages.id, s.id))
        .run()
    )
    const keptNames = new Set(kept.map((s) => s.name.trim().toLowerCase()))
    let position = kept.length
    for (const stage of stages) {
      if (keptNames.has(stage.name.trim().toLowerCase())) continue
      tx.insert(t.assignmentStages)
        .values({
          id: randomUUID(),
          assignmentId,
          position: position++,
          name: stage.name.trim(),
          estimateMinutes: stage.estimateMinutes
        })
        .run()
    }
  })
  rescheduleAssignment(db, assignmentId, now)
}

/** Move a stage up (-1) or down (+1) in the order. */
export function moveStage(db: Db, stageId: string, direction: -1 | 1, now: Temporal.Instant): void {
  const stage = db.select().from(t.assignmentStages).where(eq(t.assignmentStages.id, stageId)).get()
  if (!stage) throw new Error('Stage not found.')
  const stages = stagesOf(db, stage.assignmentId)
  const i = stages.findIndex((s) => s.id === stageId)
  const j = i + direction
  if (j < 0 || j >= stages.length) return
  db.transaction((tx) => {
    tx.update(t.assignmentStages)
      .set({ position: j })
      .where(eq(t.assignmentStages.id, stages[i].id))
      .run()
    tx.update(t.assignmentStages)
      .set({ position: i })
      .where(eq(t.assignmentStages.id, stages[j].id))
      .run()
  })
  rescheduleAssignment(db, stage.assignmentId, now)
}

// --- Planning ------------------------------------------------------------------------------

/** Future blocks of these stages that nobody has touched (not moved by hand, no outcome). */
function dropUntouchedFutureBlocks(db: DbOrTx, stageIds: string[], now: Temporal.Instant): void {
  if (!stageIds.length) return
  db.delete(t.blocks)
    .where(
      and(
        eq(t.blocks.linkedType, 'assignment-stage'),
        inArray(t.blocks.linkedId, stageIds),
        gt(t.blocks.start, toIso(now)),
        eq(t.blocks.detached, false),
        eq(t.blocks.outcome, 'none')
      )
    )
    .run()
}

/**
 * Put an assignment's work on the calendar, or take it all off (every future block with no
 * outcome, hand-moved ones too; done and past work stays). Off, nothing is planned again
 * until it's turned back on.
 */
export function setPlanned(db: Db, id: string, planned: boolean, now: Temporal.Instant): void {
  const a = db.select().from(t.assignments).where(eq(t.assignments.id, id)).get()
  if (!a) throw new Error('Assignment not found.')
  const stageIds = stagesOf(db, id).map((s) => s.id)
  db.transaction((tx) => {
    tx.update(t.assignments).set({ planned }).where(eq(t.assignments.id, id)).run()
    if (!planned && stageIds.length) {
      tx.delete(t.blocks)
        .where(
          and(
            eq(t.blocks.linkedType, 'assignment-stage'),
            inArray(t.blocks.linkedId, stageIds),
            gt(t.blocks.start, toIso(now)),
            eq(t.blocks.outcome, 'none')
          )
        )
        .run()
    }
    logChange(tx, {
      actor: 'user',
      action: planned ? 'assignment.plan' : 'assignment.unplan',
      entityType: 'assignment',
      entityId: id
    })
  })
  rescheduleAssignment(db, id, now)
}

/**
 * Change an assignment's total time: stages not done yet are rescaled in proportion (to 15
 * minutes); finished stages keep their time. Then its work is re-planned.
 */
export function setTotalEstimate(
  db: Db,
  id: string,
  totalMinutes: number,
  now: Temporal.Instant
): void {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 15 || totalMinutes > 200 * 60)
    throw new Error('Set a total between 15 minutes and 200 hours.')
  const stages = stagesOf(db, id)
  if (!stages.length) throw new Error('Assignment not found.')
  const done = stages.filter((s) => s.doneAt)
  const open = stages.filter((s) => !s.doneAt)
  if (!open.length) throw new Error('Every stage is done: there’s nothing left to rescale.')
  const doneMinutes = done.reduce((sum, s) => sum + s.estimateMinutes, 0)
  const target = Math.round(totalMinutes / 15) * 15 - doneMinutes
  if (target < open.length * 15)
    throw new Error(
      `Finished stages already take ${Math.round(doneMinutes / 6) / 10}h: set more than that.`
    )
  const openTotal = open.reduce((sum, s) => sum + s.estimateMinutes, 0) || open.length
  const scaled = open.map((s) =>
    Math.max(15, Math.round(((s.estimateMinutes || 1) * target) / openTotal / 15) * 15)
  )
  // Rounding: put the difference on the longest stage.
  const diff = target - scaled.reduce((a, b) => a + b, 0)
  const longest = scaled.indexOf(Math.max(...scaled))
  scaled[longest] = Math.max(15, scaled[longest] + diff)
  db.transaction((tx) => {
    open.forEach((s, i) =>
      tx
        .update(t.assignmentStages)
        .set({ estimateMinutes: scaled[i] })
        .where(eq(t.assignmentStages.id, s.id))
        .run()
    )
    logChange(tx, {
      actor: 'user',
      action: 'assignment.total',
      entityType: 'assignment',
      entityId: id,
      after: { totalMinutes }
    })
  })
  rescheduleAssignment(db, id, now)
}

function loggedByStage(db: DbOrTx, stageIds: string[]): Map<string, number> {
  const logged = new Map<string, number>()
  if (!stageIds.length) return logged
  for (const s of db
    .select({ id: t.sessions.linkedId, minutes: t.sessions.minutes })
    .from(t.sessions)
    .where(
      and(eq(t.sessions.linkedType, 'assignment-stage'), inArray(t.sessions.linkedId, stageIds))
    )
    .all()) {
    logged.set(s.id!, (logged.get(s.id!) ?? 0) + s.minutes)
  }
  return logged
}

/**
 * Replan an assignment's stage blocks. Keeps past blocks, finished ones and ones moved by
 * hand; plans the rest of each unfinished stage backwards from the deadline.
 */
export function rescheduleAssignment(
  db: Db,
  id: string,
  now: Temporal.Instant
): { unplacedMinutes: number } {
  const nowIso = toIso(now)
  return db.transaction((tx) => {
    const a = tx.select().from(t.assignments).where(eq(t.assignments.id, id)).get()
    if (!a) throw new Error('Assignment not found.')
    const module = tx
      .select({ categoryId: t.modules.categoryId })
      .from(t.modules)
      .where(eq(t.modules.id, a.moduleId))
      .get()!
    const stages = stagesOf(tx, id)
    const stageIds = stages.map((s) => s.id)
    dropUntouchedFutureBlocks(tx, stageIds, now)

    // Keep block titles in line with stage names (after a rename).
    for (const s of stages) {
      tx.update(t.blocks)
        .set({ title: `${s.name} · ${a.title}`, categoryId: module.categoryId })
        .where(and(eq(t.blocks.linkedType, 'assignment-stage'), eq(t.blocks.linkedId, s.id)))
        .run()
    }

    // Not on the calendar yet: nothing to place (the user plans it when ready).
    if (!a.planned && !a.submittedAt) {
      tx.update(t.assignments).set({ unplacedMinutes: 0 }).where(eq(t.assignments.id, id)).run()
      return { unplacedMinutes: 0 }
    }

    if (a.submittedAt || Temporal.Instant.compare(Temporal.Instant.from(a.due), now) <= 0) {
      const unplaced = a.submittedAt
        ? 0
        : remainingPerStage(tx, stages, now).reduce((sum, r) => sum + r.minutes, 0)
      tx.update(t.assignments)
        .set({ unplacedMinutes: unplaced })
        .where(eq(t.assignments.id, id))
        .run()
      return { unplacedMinutes: unplaced }
    }

    // Kept future blocks of this assignment count towards the daily cap.
    const kept = stageIds.length
      ? tx
          .select({ start: t.blocks.start, end: t.blocks.end })
          .from(t.blocks)
          .where(
            and(
              eq(t.blocks.linkedType, 'assignment-stage'),
              inArray(t.blocks.linkedId, stageIds),
              gt(t.blocks.start, nowIso)
            )
          )
          .all()
      : []
    const plannedPerDay = new Map<string, number>()
    for (const b of kept) {
      const d = todayLocalDate(Temporal.Instant.from(b.start)).toString()
      plannedPerDay.set(d, (plannedPerDay.get(d) ?? 0) + minutesBetween(b.start, b.end))
    }

    const busy: Interval[] = tx
      .select({ start: t.blocks.start, end: t.blocks.end })
      .from(t.blocks)
      .where(
        and(lt(t.blocks.start, a.due), gt(t.blocks.end, nowIso), ne(t.blocks.outcome, 'skipped'))
      )
      .all()

    const remaining = remainingPerStage(tx, stages, now)
    const { placements, unplaced } = backSchedule({
      stages: remaining.map((r) => ({ id: r.id, minutes: r.minutes })),
      due: a.due,
      now: nowIso,
      busy,
      availability: getAvailability(tx),
      plannedPerDay
    })

    const byId = new Map(stages.map((s) => [s.id, s]))
    for (const p of placements) {
      tx.insert(t.blocks)
        .values({
          id: `as-${randomUUID().slice(0, 12)}`,
          kind: 'flexible',
          type: 'assignment-stage',
          title: `${byId.get(p.stageId)!.name} · ${a.title}`,
          start: p.start,
          end: p.end,
          categoryId: module.categoryId,
          linkedType: 'assignment-stage',
          linkedId: p.stageId,
          source: 'auto',
          attention: p.withinAvailability ? null : OUTSIDE_AVAILABILITY
        })
        .run()
    }
    const unplacedMinutes = unplaced.reduce((s, u) => s + u.minutes, 0)
    tx.update(t.assignments).set({ unplacedMinutes }).where(eq(t.assignments.id, id)).run()
    return { unplacedMinutes }
  })
}

/** What's left of each unfinished stage: estimate − logged time − future time still planned. */
function remainingPerStage(
  db: DbOrTx,
  stages: (typeof t.assignmentStages.$inferSelect)[],
  now: Temporal.Instant
): { id: string; minutes: number }[] {
  const ids = stages.map((s) => s.id)
  const logged = loggedByStage(db, ids)
  const plannedAhead = new Map<string, number>()
  if (ids.length) {
    for (const b of db
      .select({ id: t.blocks.linkedId, start: t.blocks.start, end: t.blocks.end })
      .from(t.blocks)
      .where(
        and(
          eq(t.blocks.linkedType, 'assignment-stage'),
          inArray(t.blocks.linkedId, ids),
          gt(t.blocks.start, toIso(now)),
          eq(t.blocks.outcome, 'none')
        )
      )
      .all()) {
      plannedAhead.set(b.id!, (plannedAhead.get(b.id!) ?? 0) + minutesBetween(b.start, b.end))
    }
  }
  return stages
    .filter((s) => !s.doneAt)
    .map((s) => ({
      id: s.id,
      minutes: Math.max(
        0,
        s.estimateMinutes - (logged.get(s.id) ?? 0) - (plannedAhead.get(s.id) ?? 0)
      )
    }))
    .map((r) => ({ ...r, minutes: Math.ceil(r.minutes / 15) * 15 }))
    .filter((r) => r.minutes > 0)
}

// --- Reading -------------------------------------------------------------------------------

export function getAssignment(db: DbOrTx, id: string): AssignmentDetail | null {
  const row = db
    .select({ a: t.assignments, label: t.categories.shortLabel, colour: t.categories.colour })
    .from(t.assignments)
    .innerJoin(t.modules, eq(t.assignments.moduleId, t.modules.id))
    .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
    .where(eq(t.assignments.id, id))
    .get()
  if (!row) return null
  const stages = stagesOf(db, id)
  const ids = stages.map((s) => s.id)
  const logged = loggedByStage(db, ids)
  const blocks = ids.length
    ? db
        .select({
          id: t.blocks.id,
          start: t.blocks.start,
          end: t.blocks.end,
          outcome: t.blocks.outcome,
          attention: t.blocks.attention,
          stageId: t.blocks.linkedId
        })
        .from(t.blocks)
        .where(and(eq(t.blocks.linkedType, 'assignment-stage'), inArray(t.blocks.linkedId, ids)))
        .orderBy(asc(t.blocks.start))
        .all()
    : []
  const stageDetails: StageDetail[] = stages.map((s) => ({
    id: s.id,
    position: s.position,
    name: s.name,
    estimateMinutes: s.estimateMinutes,
    done: !!s.doneAt,
    loggedMinutes: logged.get(s.id) ?? 0,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    blocks: blocks.filter((b) => b.stageId === s.id).map(({ stageId, ...b }) => b)
  }))
  const a = row.a
  const stagesDone = stageDetails.filter((s) => s.done).length
  const loggedMinutes = stageDetails.reduce((sum, s) => sum + s.loggedMinutes, 0)
  return {
    id: a.id,
    moduleId: a.moduleId,
    moduleLabel: row.label,
    colour: row.colour,
    title: a.title,
    due: a.due,
    type: a.type,
    weighting: a.weighting,
    isGroup: a.isGroup,
    status: assignmentStatus({ submittedAt: a.submittedAt, stagesDone, loggedMinutes }),
    stagesDone,
    stagesTotal: stages.length,
    loggedMinutes,
    estimateMinutes: stages.reduce((sum, s) => sum + s.estimateMinutes, 0),
    unplacedMinutes: a.unplacedMinutes,
    wordLimit: a.wordLimit,
    briefLink: a.briefLink,
    notes: a.notes,
    summary: a.summary,
    planned: a.planned,
    submittedAt: a.submittedAt,
    mark: a.mark,
    feedback: a.feedback,
    stages: stageDetails
  }
}

/** All assignments, soonest due first (submitted ones last). */
export function listAssignments(db: DbOrTx): AssignmentSummary[] {
  const toSummary = (d: AssignmentDetail): AssignmentSummary => ({
    id: d.id,
    moduleId: d.moduleId,
    moduleLabel: d.moduleLabel,
    colour: d.colour,
    title: d.title,
    due: d.due,
    type: d.type,
    weighting: d.weighting,
    isGroup: d.isGroup,
    status: d.status,
    stagesDone: d.stagesDone,
    stagesTotal: d.stagesTotal,
    loggedMinutes: d.loggedMinutes,
    estimateMinutes: d.estimateMinutes,
    unplacedMinutes: d.unplacedMinutes,
    planned: d.planned,
    mark: d.mark
  })
  return db
    .select({ id: t.assignments.id })
    .from(t.assignments)
    .all()
    .map((r) => toSummary(getAssignment(db, r.id)!))
    .sort(
      (a, b) =>
        Number(a.status === 'submitted') - Number(b.status === 'submitted') ||
        a.due.localeCompare(b.due)
    )
}

/** The stage → assignment link, for records. */
export function assignmentForStage(db: DbOrTx, stageId: string): string | null {
  return (
    db.select().from(t.assignmentStages).where(eq(t.assignmentStages.id, stageId)).get()
      ?.assignmentId ?? null
  )
}
