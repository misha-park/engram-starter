import { and, asc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type {
  Block,
  Category,
  Deadline,
  Lecture,
  ModuleDetail,
  ModuleWithDetails,
  ReviewRating,
  TodaySummary,
  Todo
} from '../shared/types'
import { lectureStatus, splitLabelledTitle } from '../core/lectures'
import { sessionLine } from '../core/session-kinds'
import { teachingWeek } from '../core/moodle'
import {
  remainingTodayMinutes,
  unbrokenMinutes,
  weekStudyMinutes,
  workedTodayMinutes
} from '../core/totals'
import { minutesBetween, startOfDay, toIso, weekRange, zoned } from '../core/time'
import type { Db } from './db/client'
import * as t from './db/schema'
import { deadlinesInRange } from './deadlines'
import { dissertationDeadlines } from './dissertation'
import { todosDueInRange } from './todos'
import { getStartDate, lectureGroups, sessionInfo, splitEventsOf } from './timetable'

// Read queries used by IPC handlers (and later by the assistant's tools).
// Grouped by entity; split into a folder once it grows.

export function listCategories(db: Db): Category[] {
  return db.select().from(t.categories).orderBy(asc(t.categories.sortOrder)).all()
}

export function listModules(db: Db): ModuleWithDetails[] {
  const rows = db
    .select({ module: t.modules, category: t.categories })
    .from(t.modules)
    .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
    .orderBy(asc(t.categories.sortOrder))
    .all()
  const aliases = db.select().from(t.moduleAliases).all()
  return rows.map(({ module, category }) => ({
    ...module,
    name: category.name,
    shortLabel: category.shortLabel,
    colour: category.colour,
    feedNames: aliases.filter((a) => a.moduleId === module.id).map((a) => a.feedName)
  }))
}

/** One module with its lectures (by number), statuses and write-up progress. */
export function getModuleDetail(db: Db, id: string, now: Temporal.Instant): ModuleDetail | null {
  const mod = listModules(db).find((m) => m.id === id)
  if (!mod) return null
  const rows = db.select().from(t.lectures).where(eq(t.lectures.moduleId, id)).all()
  const ids = rows.flatMap((r) => [r.blockId, r.writeUpBlockId].filter((x): x is string => !!x))
  const byId = new Map(
    (ids.length ? db.select().from(t.blocks).where(inArray(t.blocks.id, ids)).all() : []).map(
      (b) => [b.id, b]
    )
  )
  // The latest review rating per lecture (spaced repetition), for the heatmap.
  const confidence = new Map<string, ReviewRating>()
  if (rows.length) {
    db.select({ lectureId: t.reviews.lectureId, step: t.reviews.step, rating: t.reviews.rating })
      .from(t.reviews)
      .where(
        inArray(
          t.reviews.lectureId,
          rows.map((r) => r.id)
        )
      )
      .all()
      .filter((r) => r.rating)
      .sort((a, b) => a.step - b.step)
      .forEach((r) => confidence.set(r.lectureId, r.rating!))
  }
  // Lectures that are parts of a split timetable event (see lecture_splits).
  const splits = splitEventsOf(db)
  // Lectures across several sessions (continues): which part each session is.
  const sessions = lectureGroups(db)
  const partOf = (blockId: string) => {
    const g = sessions.byBlock.get(blockId)
    if (!g) return null
    const blocks = [...sessions.byBlock].filter(([, x]) => x.rootId === g.rootId)
    // Sessions of one lecture are in one module, so their blocks are already loaded.
    const totalMinutes = blocks.reduce((sum, [id]) => {
      const b = byId.get(id)
      return sum + (b ? minutesBetween(b.start, b.end) : 0)
    }, 0)
    return { index: g.part, of: blocks.length, firstId: g.rootId, totalMinutes }
  }
  const startDate = getStartDate(db)
  const info = sessionInfo(db)
  const lectures: Lecture[] = rows
    .map((r) => {
      const block = byId.get(r.blockId)!
      // A later part of one lecture shares the first part's write-up.
      const part = partOf(r.blockId)
      const owner = part && part.index > 1 ? (rows.find((x) => x.id === part.firstId) ?? r) : r
      const wu = owner.writeUpBlockId ? byId.get(owner.writeUpBlockId) : undefined
      const kind = info.get(r.id)
      return {
        id: r.id,
        moduleId: r.moduleId,
        blockId: r.blockId,
        number: r.number,
        title: block.title,
        start: block.start,
        end: block.end,
        status: lectureStatus(block.end, wu?.outcome ?? null, now, r.missed),
        flashcards: !!r.flashcardsAt,
        notes: !!r.notesAt,
        noWriteUp: r.noWriteUp,
        kind: kind?.kind ?? 'lecture',
        kindConfirmed: kind?.kindConfirmed ?? false,
        label: kind?.label ?? `L${r.number}`,
        confidence: confidence.get(r.id) ?? null,
        week: teachingWeek(block.start),
        topic: r.title ?? null,
        topicLocked: r.titleLocked,
        part,
        splitPart: splits.some(
          (x) => x.moduleId === r.moduleId && x.start <= block.start && x.end >= block.end
        ),
        canSplit: false,
        beforeStart:
          !!startDate &&
          Temporal.PlainDate.compare(
            zoned(block.start).toPlainDate(),
            Temporal.PlainDate.from(startDate)
          ) < 0,
        writeUp: wu
          ? {
              id: wu.id,
              start: wu.start,
              end: wu.end,
              outcome: wu.outcome,
              attention: wu.attention
            }
          : null
      }
    })
    .sort((a, b) => a.number - b.number)
  lectures.forEach((l) => {
    l.canSplit = !l.splitPart && minutesBetween(l.start, l.end) > 60
  })
  // A later session of one lecture goes by its first session's choice.
  const noWriteUp = (l: Lecture) =>
    (l.part ? lectures.find((x) => x.id === l.part!.firstId) : l)?.noWriteUp ?? false
  return {
    ...mod,
    lectures,
    // Sessions that need no write-up (you said so) don't count towards "x/y written up".
    lecturesSoFar: lectures.filter((l) => l.status !== 'scheduled' && !noWriteUp(l)).length,
    writtenUp: lectures.filter((l) => l.status === 'written-up' && !noWriteUp(l)).length,
    timetabledSessionCount: db
      .select({ id: t.blocks.id })
      .from(t.blocks)
      .where(
        and(
          eq(t.blocks.source, 'timetable'),
          eq(t.blocks.categoryId, mod.categoryId),
          inArray(t.blocks.type, ['practical', 'workshop'])
        )
      )
      .all().length,
    assessments: db
      .select({ blockId: t.blocks.id, start: t.blocks.start, end: t.blocks.end })
      .from(t.blocks)
      .where(
        and(
          eq(t.blocks.source, 'timetable'),
          eq(t.blocks.categoryId, mod.categoryId),
          eq(t.blocks.type, 'assessment')
        )
      )
      .orderBy(asc(t.blocks.start))
      .all()
  }
}

/** Blocks overlapping [startIso, endIso). */
export function listBlocksInRange(db: Db, startIso: string, endIso: string): Block[] {
  const rows = db
    .select({
      id: t.blocks.id,
      kind: t.blocks.kind,
      type: t.blocks.type,
      title: t.blocks.title,
      start: t.blocks.start,
      end: t.blocks.end,
      categoryId: t.blocks.categoryId,
      linkedType: t.blocks.linkedType,
      linkedId: t.blocks.linkedId,
      source: t.blocks.source,
      outcome: t.blocks.outcome,
      recurrenceId: t.blocks.recurrenceId,
      occurrenceDate: t.blocks.occurrenceDate,
      debriefPending: t.blocks.debriefPending,
      detached: t.blocks.detached,
      attention: t.blocks.attention,
      colour: t.blocks.colour,
      notes: t.blocks.notes
    })
    .from(t.blocks)
    .where(and(lt(t.blocks.start, endIso), gt(t.blocks.end, startIso)))
    .orderBy(asc(t.blocks.start))
    .all()
  return withDisplay(db, rows)
}

/** A block's name as people read it: "Cellular Neurophysiology · Write-up · L7". */
export function blockLabel(db: Db, blockId: string, fallback: string): string {
  const b = db.select().from(t.blocks).where(eq(t.blocks.id, blockId)).get()
  if (!b) return fallback
  const [shown] = withDisplay(db, [b as unknown as Block])
  return shown.detail ? `${shown.heading} · ${shown.detail}` : (shown.heading ?? fallback)
}

/**
 * What each block's bubble shows: the module's name on top, then the lecture ("L12. Ion
 * channels", or "L12" with no name yet), its write-up, or an assignment's stage.
 */
export function withDisplay(db: Db, blocks: Block[]): Block[] {
  if (!blocks.length) return blocks
  const ids = blocks.map((b) => b.id)
  const lectures = db
    .select({
      id: t.lectures.id,
      blockId: t.lectures.blockId,
      writeUpBlockId: t.lectures.writeUpBlockId,
      moduleId: t.lectures.moduleId,
      number: t.lectures.number,
      title: t.lectures.title
    })
    .from(t.lectures)
    .where(or(inArray(t.lectures.blockId, ids), inArray(t.lectures.writeUpBlockId, ids)))
    .all()
  const groups = lectures.length ? lectureGroups(db).byBlock : new Map()
  // A later session of a lecture shows the first session's name.
  const rootIds = [...new Set([...groups.values()].map((g) => g.rootId))]
  const rootTitle = new Map(
    rootIds.length
      ? db
          .select({ id: t.lectures.id, title: t.lectures.title })
          .from(t.lectures)
          .where(inArray(t.lectures.id, rootIds))
          .all()
          .map((r) => [r.id, r.title])
      : []
  )
  const info = lectures.length ? sessionInfo(db) : new Map()
  const labelOf = (id: string) => info.get(id)?.label ?? ''
  const byBlock = new Map(lectures.map((l) => [l.blockId, l]))
  const byWriteUp = new Map(
    lectures.filter((l) => l.writeUpBlockId).map((l) => [l.writeUpBlockId!, l])
  )
  const cats = new Map(
    db
      .select({ id: t.categories.id, name: t.categories.name, shortLabel: t.categories.shortLabel })
      .from(t.categories)
      .innerJoin(t.modules, eq(t.modules.categoryId, t.categories.id))
      .all()
      .map((c) => [c.id, c])
  )
  const stageIds = blocks.filter((b) => b.linkedType === 'assignment-stage').map((b) => b.linkedId!)
  const stages = new Map(
    stageIds.length
      ? db
          .select({
            id: t.assignmentStages.id,
            name: t.assignmentStages.name,
            title: t.assignments.title
          })
          .from(t.assignmentStages)
          .innerJoin(t.assignments, eq(t.assignments.id, t.assignmentStages.assignmentId))
          .where(inArray(t.assignmentStages.id, stageIds))
          .all()
          .map((r) => [r.id, r])
      : []
  )
  const deadlineIds = blocks.filter((b) => b.linkedType === 'deadline').map((b) => b.linkedId!)
  const deadlineTitles = new Map(
    deadlineIds.length
      ? db
          .select({ id: t.deadlines.id, title: t.deadlines.title })
          .from(t.deadlines)
          .where(inArray(t.deadlines.id, deadlineIds))
          .all()
          .map((r) => [r.id, r.title])
      : []
  )
  return blocks.map((b) => {
    const mod = b.categoryId ? cats.get(b.categoryId) : undefined
    const lecture = byBlock.get(b.id)
    if (lecture && mod) {
      const g = groups.get(b.id)
      const title = g && g.part > 1 ? (rootTitle.get(g.rootId) ?? lecture.title) : lecture.title
      return {
        ...b,
        lecture: { id: lecture.id, moduleId: lecture.moduleId, title },
        heading: mod.name,
        detail: sessionLine(labelOf(lecture.id), title, g?.part ?? 1)
      }
    }
    const writeUp = byWriteUp.get(b.id)
    if (writeUp && mod) {
      return {
        ...b,
        lecture: { id: writeUp.id, moduleId: writeUp.moduleId, title: writeUp.title },
        heading: mod.name,
        detail: `Write-up · ${sessionLine(labelOf(writeUp.id), writeUp.title)}`
      }
    }
    const stage = b.linkedType === 'assignment-stage' ? stages.get(b.linkedId!) : undefined
    // An event added by hand for an assignment shows its own title, unless that's just the
    // assignment's name.
    if (stage) {
      const own = b.type === 'other' && b.title !== stage.title
      return { ...b, heading: stage.title, detail: own ? b.title : stage.name }
    }
    const deadline = b.linkedType === 'deadline' ? deadlineTitles.get(b.linkedId!) : undefined
    if (deadline) {
      return {
        ...b,
        heading: deadline,
        detail: b.title !== deadline ? b.title : 'Work for this deadline'
      }
    }
    return { ...b, ...splitLabelledTitle(b.title, mod?.shortLabel ?? null, mod?.name ?? null) }
  })
}

/**
 * Deadlines in [startIso, endIso): timetabled assessments, viva-session days (one per day,
 * from the feed's cohort viva events) and assignment due dates.
 */
export function listDeadlines(db: Db, startIso: string, endIso: string): Deadline[] {
  const timetabled: Deadline[] = db
    .select({
      id: t.blocks.id,
      title: t.blocks.title,
      at: t.blocks.start,
      categoryId: t.blocks.categoryId,
      type: t.blocks.type
    })
    .from(t.blocks)
    .where(
      and(
        inArray(t.blocks.type, ['assessment', 'viva']),
        lt(t.blocks.start, endIso),
        gt(t.blocks.end, startIso)
      )
    )
    .all()
    .map(({ type, ...d }) => ({ ...d, kind: type as 'assessment' | 'viva' }))
  // "PHYS Assessment" reads as "Systems Physiology Assessment", like the calendar's bubbles.
  const named = withDisplay(db, timetabled as unknown as Block[])
  timetabled.forEach((d, i) => {
    const b = named[i]
    if (b.detail) d.title = `${b.heading} ${b.detail.toLowerCase()}`
  })
  const aliases = new Map(
    db
      .select({
        name: t.moduleAliases.feedName,
        categoryId: t.modules.categoryId,
        label: t.categories.name
      })
      .from(t.moduleAliases)
      .innerJoin(t.modules, eq(t.moduleAliases.moduleId, t.modules.id))
      .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
      .all()
      .map((a) => [a.name, a])
  )
  const vivaDays = new Map<string, Deadline>()
  for (const ev of db
    .select()
    .from(t.timetableEvents)
    .where(
      and(
        eq(t.timetableEvents.type, 'viva'),
        lt(t.timetableEvents.start, endIso),
        gt(t.timetableEvents.end, startIso)
      )
    )
    .orderBy(asc(t.timetableEvents.start))
    .all()) {
    const alias = aliases.get(ev.moduleName)
    const day = Temporal.Instant.from(ev.start)
      .toZonedDateTimeISO('Europe/London')
      .toPlainDate()
      .toString()
    const key = `${day}|${alias?.categoryId ?? ev.moduleName}`
    if (!vivaDays.has(key)) {
      vivaDays.set(key, {
        id: `viva-${day}-${alias?.categoryId ?? 'unmapped'}`,
        title: `${alias?.label ?? ev.moduleName} viva sessions`,
        at: ev.start,
        categoryId: alias?.categoryId ?? null,
        kind: 'viva'
      })
    }
  }
  const assignments: Deadline[] = db
    .select({
      id: t.assignments.id,
      title: t.assignments.title,
      at: t.assignments.due,
      categoryId: t.modules.categoryId
    })
    .from(t.assignments)
    .innerJoin(t.modules, eq(t.assignments.moduleId, t.modules.id))
    .where(and(gt(t.assignments.due, startIso), lt(t.assignments.due, endIso)))
    .all()
    .map((d) => ({ ...d, id: `assignment-${d.id}`, kind: 'assignment' as const }))
  const dissertation = dissertationDeadlines(db, startIso, endIso)
  const general = deadlinesInRange(db, startIso, endIso)
  const todos = todosDueInRange(db, startIso, endIso)
  return [
    ...timetabled,
    ...vivaDays.values(),
    ...assignments,
    ...dissertation,
    ...general,
    ...todos
  ].sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * Todos for the sidebar: everything open, plus ones ticked in the last 3 days (older ticked
 * ones, e.g. past instances of a recurring todo, are history). Undated ones last.
 */
export function listTodos(db: Db, now: Temporal.Instant = Temporal.Now.instant()): Todo[] {
  const since = toIso(now.subtract({ hours: 72 }))
  const rows = db
    .select()
    .from(t.todos)
    .where(eq(t.todos.archived, false))
    .all()
    .filter((r) => !r.done || (r.doneAt ?? '') >= since)
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      done: r.done,
      archived: r.archived,
      dueDate: r.dueDate,
      linkedType: r.linkedType,
      linkedId: r.linkedId,
      recurrence: r.recurrence ?? null,
      source: r.source
    }))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
}

export function getSetting<T>(db: Db, key: string): T | null {
  const row = db.select().from(t.settings).where(eq(t.settings.key, key)).get()
  return row ? (row.value as T) : null
}

export function getTodaySummary(db: Db, now: Temporal.Instant): TodaySummary {
  const week = weekRange(now)
  const dayStart = startOfDay(now)
  // Everything from the start of the week (or yesterday, for a stretch across midnight);
  // a running timer has no end yet and counts up to now.
  const from = toIso(
    Temporal.Instant.compare(week.start.toInstant(), dayStart.subtract({ days: 1 }).toInstant()) < 0
      ? week.start
      : dayStart.subtract({ days: 1 })
  )
  const sessions = db
    .select({ start: t.sessions.start, end: t.sessions.end })
    .from(t.sessions)
    .where(
      and(
        lt(t.sessions.start, toIso(week.end)),
        or(gt(t.sessions.end, from), isNull(t.sessions.end))
      )
    )
    .all()
  const todays = listBlocksInRange(db, toIso(dayStart), toIso(dayStart.add({ days: 1 })))
  return {
    weekMinutes: weekStudyMinutes(sessions, now),
    weekTargetMinutes: getSetting<number>(db, 'weeklyTargetMinutes'),
    remainingTodayMinutes: remainingTodayMinutes(todays, now),
    workedTodayMinutes: workedTodayMinutes(sessions, now),
    unbrokenMinutes: unbrokenMinutes(sessions, now)
  }
}
