import { randomUUID } from 'crypto'
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type { BacklogItem, Block, NotificationItem } from '../shared/types'
import { isOverdue } from '../core/todos'
import { lectureLine, writeUpMinutesFor } from '../core/lectures'
import { findSlot } from '../core/scheduler'
import {
  atLocalTime,
  formatClock,
  minutesBetween,
  toIso,
  todayLocalDate,
  zoned
} from '../core/time'
import { getAvailability, getBlock, logChange, moveBlock } from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { listCheckins } from './sessions'
import { pendingForumPosts } from './moodle/forums'
import { pendingBriefs } from './moodle/sync'
import { getStartDate, reconcileTimetable, rootLectureId } from './timetable'
import { getTodo } from './todos'
import { blockLabel, withDisplay } from './repo'

// The Backlog: everything that slipped, across the app, and the ways to schedule it.
//
//   unmarked              past flexible blocks with no outcome (scheduling moves the block itself)
//   partial / skipped     follow-up work for a block (scheduling adds a follow-up block)
//   unscheduled-write-up  a lecture whose write-up couldn't be placed
//   overdue-assignment    past its due date and not submitted (open it, or mark it submitted)
//   overdue-todo          a todo past its due date (tick it, or schedule it as a block)
//
// Partial and skipped *assignment* blocks aren't listed: the assignment replans what's left.

const dayLabel = (iso: string) =>
  zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const span = (b: { start: string; end: string }) =>
  `${dayLabel(b.start)}, ${formatClock(b.start)}–${formatClock(b.end)}`
const roundUp15 = (m: number) => Math.max(15, Math.ceil(m / 15) * 15)

export function listBacklog(db: Db, now: Temporal.Instant): BacklogItem[] {
  const nowIso = toIso(now)
  const colours = new Map(
    db
      .select()
      .from(t.categories)
      .all()
      .map((c) => [c.id, c.colour])
  )
  const colour = (id: string | null) => (id ? (colours.get(id) ?? null) : null)
  const items: BacklogItem[] = []

  // Blocks of submitted assignments don't need anything any more.
  const submittedStages = new Set(
    db
      .select({ id: t.assignmentStages.id })
      .from(t.assignmentStages)
      .innerJoin(t.assignments, eq(t.assignmentStages.assignmentId, t.assignments.id))
      .where(isNotNull(t.assignments.submittedAt))
      .all()
      .map((r) => r.id)
  )
  // Blocks with a running timer or a check-in waiting are handled by the check-in flow.
  const inFlight = new Set(
    db
      .select({ blockId: t.sessions.blockId })
      .from(t.sessions)
      .where(isNull(t.sessions.outcome))
      .all()
      .map((r) => r.blockId)
  )

  const past = db
    .select()
    .from(t.blocks)
    .where(
      and(
        eq(t.blocks.kind, 'flexible'),
        isNull(t.blocks.backlogResolvedAt),
        // Past blocks; plus ones already skipped, even if their time hasn't come yet.
        or(lt(t.blocks.end, nowIso), inArray(t.blocks.outcome, ['skipped', 'partial']))
      )
    )
    .all()
  // Titles as the calendar shows them: "Molecular Pharmacology: Write-up · L1".
  const shown = new Map(
    withDisplay(db, past as unknown as Block[]).map((b) => [
      b.id,
      b.detail ? `${b.heading}: ${b.detail}` : (b.heading ?? b.title)
    ])
  )
  for (const b of past) {
    if (b.linkedType === 'assignment-stage' && b.linkedId && submittedStages.has(b.linkedId))
      continue
    if (inFlight.has(b.id)) continue
    // Spaced-repetition reviews are followed up on the Revision tab instead.
    if (b.type === 'review') continue
    const minutes = minutesBetween(b.start, b.end)
    const base = {
      title: shown.get(b.id) ?? b.title,
      categoryId: b.categoryId,
      colour: b.colour ?? colour(b.categoryId),
      at: b.start,
      blockId: b.id
    }
    if (b.outcome === 'none') {
      items.push({
        ...base,
        key: `unmarked:${b.id}`,
        kind: 'unmarked',
        detail: `Planned ${span(b)} · not marked`,
        minutes
      })
    } else if (
      (b.outcome === 'partial' || b.outcome === 'skipped') &&
      b.linkedType !== 'assignment-stage'
    ) {
      const debrief = b.outcome === 'partial' ? lastDebrief(db, b.id) : null
      items.push({
        ...base,
        key: `${b.outcome}:${b.id}`,
        kind: b.outcome,
        detail:
          b.outcome === 'partial'
            ? `Partly done ${span(b)}${debrief ? ` · ${debrief}` : ''}`
            : `Skipped ${span(b)}`,
        // A follow-up for partial work defaults to half the original block.
        minutes: b.outcome === 'partial' ? roundUp15(minutes / 2) : minutes
      })
    }
  }

  // Lectures (already over) whose write-up couldn't be placed, or from before the start date.
  const startDate = getStartDate(db)
  const startIso = startDate ? toIso(atLocalTime(startDate, '00:00')) : null
  for (const row of db
    .select({
      lecture: t.lectures,
      block: t.blocks,
      minutes: t.modules.writeUpMinutes,
      moduleName: t.categories.name
    })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .innerJoin(t.modules, eq(t.lectures.moduleId, t.modules.id))
    .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
    .where(and(isNull(t.lectures.writeUpBlockId), lt(t.blocks.end, nowIso)))
    .all()) {
    // A later session of a lecture across several shares the first's write-up; and you
    // deleted some write-ups on purpose.
    if (row.lecture.continuesId || row.lecture.noWriteUp) continue
    items.push({
      key: `unscheduled-write-up:${row.lecture.id}`,
      kind: 'unscheduled-write-up',
      title: `${row.moduleName}: Write-up · ${lectureLine(row.lecture.number, row.lecture.title)}`,
      detail:
        startIso && row.block.start < startIso
          ? `Lecture ${span(row.block)} · from before you started using Engram`
          : `Lecture ${span(row.block)} · no slot was found for the write-up`,
      categoryId: row.block.categoryId,
      colour: colour(row.block.categoryId),
      at: row.block.end,
      minutes: writeUpMinutesFor(minutesBetween(row.block.start, row.block.end), row.minutes),
      lectureId: row.lecture.id
    })
  }

  // Assignments past their due date and not submitted.
  for (const row of db
    .select({ a: t.assignments, categoryId: t.modules.categoryId })
    .from(t.assignments)
    .innerJoin(t.modules, eq(t.assignments.moduleId, t.modules.id))
    .where(and(isNull(t.assignments.submittedAt), lt(t.assignments.due, nowIso)))
    .all()) {
    items.push({
      key: `overdue-assignment:${row.a.id}`,
      kind: 'overdue-assignment',
      title: row.a.title,
      detail: `Was due ${dayLabel(row.a.due)}, ${formatClock(row.a.due)} · not marked submitted`,
      categoryId: row.categoryId,
      colour: colour(row.categoryId),
      at: row.a.due,
      minutes: null,
      assignmentId: row.a.id
    })
  }

  // Overdue todos.
  const today = todayLocalDate(now)
  for (const todo of db.select().from(t.todos).all()) {
    if (!isOverdue(todo, today)) continue
    items.push({
      key: `overdue-todo:${todo.id}`,
      kind: 'overdue-todo',
      title: todo.title,
      detail: `Was due ${Temporal.PlainDate.from(todo.dueDate!).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`,
      categoryId: null,
      colour: null,
      at: toIso(
        Temporal.PlainDate.from(todo.dueDate!).toZonedDateTime({ timeZone: 'Europe/London' })
      ),
      minutes: 30,
      todoId: todo.id
    })
  }

  return items.sort((a, b) => a.at.localeCompare(b.at))
}

function lastDebrief(db: Db, blockId: string): string | null {
  const s = db
    .select({ debrief: t.sessions.debrief })
    .from(t.sessions)
    .where(and(eq(t.sessions.blockId, blockId), isNotNull(t.sessions.debrief)))
    .all()
    .at(-1)
  if (!s?.debrief) return null
  const text = s.debrief.replace(/\s+/g, ' ').trim()
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}

/** The first free slot from now (within two weeks), inside availability if possible. */
export function nextFreeSlot(
  db: Db,
  minutes: number,
  now: Temporal.Instant
): { start: string; end: string } {
  const until = now.add({ hours: 24 * 14 })
  const busy = db
    .select({ start: t.blocks.start, end: t.blocks.end })
    .from(t.blocks)
    .where(
      and(
        lt(t.blocks.start, toIso(until)),
        gt(t.blocks.end, toIso(now)),
        ne(t.blocks.outcome, 'skipped')
      )
    )
    .all()
  const slot = findSlot({
    from: toIso(now),
    until: toIso(until),
    durationMinutes: minutes,
    busy,
    availability: getAvailability(db)
  })
  if (!slot) throw new Error('No free time in the next two weeks.')
  return slot
}

/**
 * Schedule a Backlog item at `start` (e.g. where it was dropped on the calendar), or in the next
 * free slot when `start` is omitted. Returns the block that now holds the work.
 */
export function scheduleBacklogItem(
  db: Db,
  key: string,
  opts: { start?: string; minutes?: number },
  now: Temporal.Instant
): string {
  const [kind, id] = splitKey(key)
  const place = (minutes: number) => {
    const m = roundUp15(opts.minutes ?? minutes)
    if (!opts.start) return nextFreeSlot(db, m, now)
    const start = Temporal.Instant.from(opts.start)
    return { start: toIso(start), end: toIso(start.add({ minutes: m })) }
  }

  if (kind === 'unmarked') {
    const block = getBlock(db, id)
    if (!block || block.outcome !== 'none') throw new Error('That block is no longer waiting.')
    const slot = place(minutesBetween(block.start, block.end))
    return moveBlock(db, id, slot.start, slot.end, 'user').id
  }

  if (kind === 'partial' || kind === 'skipped') {
    const block = getBlock(db, id)
    if (!block || block.outcome !== kind) throw new Error('That block is no longer waiting.')
    const minutes = minutesBetween(block.start, block.end)
    const slot = place(kind === 'partial' ? minutes / 2 : minutes)
    const followUp = `fu-${randomUUID().slice(0, 12)}`
    db.transaction((tx) => {
      tx.insert(t.blocks)
        .values({
          id: followUp,
          kind: 'flexible',
          type: block.type,
          title:
            kind === 'partial'
              ? `${block.title.replace(/ \(continued\)$/, '')} (continued)`
              : block.title,
          start: slot.start,
          end: slot.end,
          categoryId: block.categoryId,
          linkedType: block.linkedType,
          linkedId: block.linkedId,
          source: 'user',
          detached: true
        })
        .run()
      tx.update(t.blocks)
        .set({ backlogResolvedAt: toIso(now) })
        .where(eq(t.blocks.id, id))
        .run()
      logChange(tx, {
        actor: 'user',
        action: 'backlog.followUp',
        entityType: 'block',
        entityId: id,
        after: { followUp, ...slot }
      })
    })
    return followUp
  }

  if (kind === 'unscheduled-write-up') {
    const row = db
      .select({
        lecture: t.lectures,
        block: t.blocks,
        minutes: t.modules.writeUpMinutes,
        categoryId: t.modules.categoryId
      })
      .from(t.lectures)
      .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
      .innerJoin(t.modules, eq(t.lectures.moduleId, t.modules.id))
      .where(eq(t.lectures.id, id))
      .get()
    if (!row || row.lecture.writeUpBlockId) throw new Error('That write-up is already scheduled.')
    const slot = place(
      writeUpMinutesFor(minutesBetween(row.block.start, row.block.end), row.minutes)
    )
    const blockId = `wu-${id.slice(4)}`
    db.transaction((tx) => {
      tx.delete(t.blocks).where(eq(t.blocks.id, blockId)).run()
      tx.insert(t.blocks)
        .values({
          id: blockId,
          kind: 'flexible',
          type: 'write-up',
          title: `${row.block.title} write-up`,
          start: slot.start,
          end: slot.end,
          categoryId: row.categoryId,
          linkedType: 'lecture',
          linkedId: id,
          source: 'user',
          detached: true
        })
        .run()
      tx.update(t.lectures).set({ writeUpBlockId: blockId }).where(eq(t.lectures.id, id)).run()
      logChange(tx, {
        actor: 'user',
        action: 'backlog.scheduleWriteUp',
        entityType: 'lecture',
        entityId: id,
        after: slot
      })
    })
    return blockId
  }

  if (kind === 'overdue-todo' || kind === 'todo') return scheduleTodo(db, id, opts, now)

  throw new Error('This item can’t be scheduled directly.')
}

/** Turn a todo into a flexible block (anything with an estimate belongs on the calendar). */
export function scheduleTodo(
  db: Db,
  todoId: string,
  opts: { start?: string; minutes?: number },
  now: Temporal.Instant
): string {
  const todo = getTodo(db, todoId)
  if (!todo || todo.done) throw new Error('Todo not found or already done.')
  const minutes = roundUp15(opts.minutes ?? 30)
  const slot = opts.start
    ? {
        start: toIso(Temporal.Instant.from(opts.start)),
        end: toIso(Temporal.Instant.from(opts.start).add({ minutes }))
      }
    : nextFreeSlot(db, minutes, now)
  let categoryId: string | null = null
  if (todo.linkedType === 'module' && todo.linkedId) {
    categoryId =
      db.select().from(t.modules).where(eq(t.modules.id, todo.linkedId)).get()?.categoryId ?? null
  }
  const id = `todo-${randomUUID().slice(0, 12)}`
  db.insert(t.blocks)
    .values({
      id,
      kind: 'flexible',
      type: 'other',
      title: todo.title,
      start: slot.start,
      end: slot.end,
      categoryId,
      linkedType: 'todo',
      linkedId: todoId,
      source: 'user',
      detached: true
    })
    .run()
  logChange(db, {
    actor: 'user',
    action: 'todo.schedule',
    entityType: 'todo',
    entityId: todoId,
    after: slot
  })
  return id
}

/** Let a partial or skipped block go without rescheduling it. */
export function dismissBacklogItem(db: Db, key: string, now: Temporal.Instant): void {
  const [kind, id] = splitKey(key)
  if (kind !== 'partial' && kind !== 'skipped') {
    throw new Error('Only partial and skipped blocks can be let go; mark or schedule the rest.')
  }
  db.update(t.blocks)
    .set({ backlogResolvedAt: toIso(now) })
    .where(eq(t.blocks.id, id))
    .run()
  logChange(db, { actor: 'user', action: 'backlog.dismiss', entityType: 'block', entityId: id })
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':')
  if (i < 0) throw new Error('Invalid item.')
  return [key.slice(0, i), key.slice(i + 1)]
}

// --- Notifications -------------------------------------------------------------------------

/** The bell's list: pending debriefs, check-ins waiting, and missed or overdue todos. */
export function listNotifications(db: Db, now: Temporal.Instant): NotificationItem[] {
  const items: NotificationItem[] = []
  for (const b of db.select().from(t.blocks).where(eq(t.blocks.debriefPending, true)).all()) {
    items.push({
      key: `debrief:${b.id}`,
      kind: 'debrief',
      title: blockLabel(db, b.id, b.title),
      detail: `Debrief pending · ${span(b)}`,
      at: b.end,
      blockId: b.id
    })
  }
  for (const c of listCheckins(db)) {
    items.push({
      key: `checkin:${c.sessionId}`,
      kind: 'checkin',
      title: c.title,
      detail:
        c.kind === 'timed-out'
          ? 'Timer stopped itself · confirm the time'
          : 'Stopped · how did it go?',
      at: c.end,
      blockId: c.blockId
    })
  }
  const today = todayLocalDate(now)
  for (const todo of db.select().from(t.todos).all()) {
    if (!isOverdue(todo, today)) continue
    items.push({
      key: `todo:${todo.id}`,
      kind: 'overdue-todo',
      title: todo.title,
      detail: `Todo overdue since ${Temporal.PlainDate.from(todo.dueDate!).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      })}`,
      at: todo.dueDate!,
      todoId: todo.id
    })
  }
  // Assignment briefs from Moodle that didn't match an assignment: plan one from them.
  for (const brief of pendingBriefs(db)) {
    items.push({
      key: `moodle-brief:${brief.key}`,
      kind: 'moodle-brief',
      title: brief.title,
      detail: 'New assignment brief on Moodle · plan the assignment from it',
      at: brief.createdAt,
      attachmentId: brief.attachmentId!
    })
  }
  // Important posts in the modules' Moodle forums (announcements, staff changes).
  for (const post of pendingForumPosts(db)) {
    items.push({
      key: `moodle-forum:${post.id}`,
      kind: 'moodle-forum',
      title: `${post.label}: ${post.title ?? post.subject ?? 'Post on Moodle'}`,
      detail: [post.kind === 'announcement' ? 'Announcement' : post.forum, post.author]
        .filter(Boolean)
        .join(' · '),
      at: Temporal.Instant.fromEpochMilliseconds(post.created * 1000).toString(),
      postId: post.id
    })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * A lecture's write-up, made if it has none (deleted, never placed, or from before the
 * start date): placed like Engram places write-ups, else at the next free time. For a
 * merged lecture, the first session's.
 */
export function ensureWriteUp(
  db: Db,
  lectureId: string,
  now: Temporal.Instant
): { blockId: string; created: boolean } {
  const id = rootLectureId(db, lectureId)
  const get = () => db.select().from(t.lectures).where(eq(t.lectures.id, id)).get()
  const lecture = get()
  if (!lecture) throw new Error('Lecture not found.')
  if (lecture.writeUpBlockId && getBlock(db, lecture.writeUpBlockId)) {
    return { blockId: lecture.writeUpBlockId, created: false }
  }
  if (lecture.noWriteUp) {
    db.update(t.lectures).set({ noWriteUp: false }).where(eq(t.lectures.id, id)).run()
  }
  // A lecture still to come gets one the way Engram places write-ups; one that's over gets
  // the next free time (the usual placement would put it in the past).
  const own = getBlock(db, lecture.blockId)
  if (own && own.end > toIso(now)) {
    reconcileTimetable(db, now)
    const placed = get()?.writeUpBlockId
    if (placed) return { blockId: placed, created: true }
  }
  return { blockId: scheduleBacklogItem(db, `unscheduled-write-up:${id}`, {}, now), created: true }
}
