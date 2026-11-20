import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { z } from 'zod'
import { formatMinutes, minutesBetween, toIso, weekRange } from '../../core/time'
import {
  ASSIGNMENT_TYPES,
  ATTACHMENT_TARGETS,
  READING_STATUSES,
  SECTION_STATUSES,
  type Attachment,
  type Block,
  type ConversationMode,
  type TodoSuggestion
} from '../../shared/types'
import * as assignments from '../assignments'
import * as files from '../attachments'
import * as dissertation from '../dissertation'
import * as deadlinesDomain from '../deadlines'
import { removeBlock } from '../remove-block'
import * as backlog from '../backlog'
import {
  createRecurringEvent,
  endSeriesAfter,
  getAvailability,
  getBlock,
  getRecurrence,
  moveBlock,
  removeOccurrence,
  setAvailability,
  updateBlock,
  updateRecurrence
} from '../calendar'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { recordPath, targetForBlock, type RecordTarget } from '../records'
import * as repo from '../repo'
import * as sessions from '../sessions'
import * as timetable from '../timetable'
import * as moodleSync from '../moodle/sync'
import * as forums from '../moodle/forums'
import { organiseModule, type CompleteJson } from '../moodle/lectures'
import { statsOverview } from '../stats'
import { findItems } from './find'
import { addMemory, MEMORY_TEXT_MAX, removeMemory } from './memory'
import { takeTimeOff } from './time-off'
import { archiveTodo, createTodo, setTodoDone, updateTodo } from '../todos'
import * as reviewsDomain from '../reviews'
import * as setup from '../setup'
import { recentBatches, undoBatch } from './changes'
import {
  dayLabel,
  freeSlots,
  lateWriteUpNote,
  parseLocal,
  pastWriteUpLimit,
  placementProblems,
  toLocal
} from './placement'

// The assistant's tools. Each one calls the same domain and scheduling code as the UI.
// They are plain definitions (name, description, zod shape, handler) so they can be tested
// without the Agent SDK; runner.ts turns them into SDK tools.

export interface ToolContext {
  db: Db
  recordsDir: string
  now(): Temporal.Instant
  mode: ConversationMode
  /** Show todo suggestions in the panel for the user to approve (debriefs). */
  suggest(todos: TodoSuggestion[]): void
  /** Where the profile keeps attached files. */
  filesDir: string
  /** Open "Plan from brief" in the app with this file, for the user to check and save. */
  planBrief(attachmentId: string, assignmentId: string | null): void
  /** A one-off structured Claude call (Organise lectures). Absent in tests. */
  completeJson?: CompleteJson
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  shape: S
  /** Changes data: the call is tracked for the turn's batch (undo, review). */
  mutates: boolean
  /** Which conversations get this tool. */
  modes: ConversationMode['kind'][]
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): unknown
}

const def = <S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef

const ALL: ConversationMode['kind'][] = ['chat', 'debrief', 'checkin', 'dissertation']
/** Conversations that may plan and change things (not debriefs or check-ins). */
const CHAT: ConversationMode['kind'][] = ['chat', 'dissertation']

const localTime = z.string().describe('London time as YYYY-MM-DDTHH:mm, e.g. 2026-11-19T14:00')
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

/** How a file is shown to Claude. */
const describeFile = (f: Attachment) => ({
  id: f.id,
  name: f.name,
  attachedTo: f.target ? { type: f.target.type, id: f.target.id, name: f.targetLabel } : null,
  readable: f.readable,
  added: f.createdAt.slice(0, 10)
})

/** "2026-11-19T15:00" when it ends the day it starts, else the full local time. */
function endView(startIso: string, endIso: string): string {
  const start = toLocal(startIso)
  const end = toLocal(endIso)
  return end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end
}

/**
 * How a block is shown to Claude. Kept short (a long schedule is many of these): the end is
 * just HH:mm on the same day, and defaults (flexible, no outcome) are left out.
 */
function blockView(b: Block) {
  return {
    id: b.id,
    title: b.title,
    start: toLocal(b.start),
    end: endView(b.start, b.end),
    day: zonedWeekday(b.start),
    type: b.type,
    // Fixed blocks (timetable, pub shift, social plans) never move automatically.
    ...(b.kind === 'flexible' ? {} : { fixed: true }),
    ...(b.outcome !== 'none' ? { outcome: b.outcome } : {}),
    ...(b.linkedType ? { linked: `${b.linkedType}:${b.linkedId}` } : {}),
    ...(b.attention ? { attention: b.attention } : {})
  }
}

/** "Thu" */
const zonedWeekday = (iso: string) => dayLabel(iso).slice(0, 3)

const dayStartIso = (date: string) =>
  toIso(Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: 'Europe/London' }))

function requireBlock(db: Db, id: string): Block {
  const b = getBlock(db, id)
  if (!b) throw new Error(`No block with id ${id}. Use get_schedule to find ids.`)
  return b
}

function refuseIfProblems(problems: string[]): void {
  if (problems.length) {
    throw new Error(
      `Not placed: ${problems.join(' ')} Use find_free_slots to find a time that fits, or tell the user why it can’t be done.`
    )
  }
}

const pastLimitRequested = z
  .boolean()
  .optional()
  .describe(
    'Only when the user explicitly asked for this time for a write-up past its 3-working-day limit. It is placed and flagged in red; tell the user it is past the limit.'
  )

export const TOOLS: ToolDef[] = [
  // --- Reading ------------------------------------------------------------------------------
  def({
    name: 'get_schedule',
    description:
      'Calendar blocks between two dates (inclusive), with deadlines. Use this to find block ids and see what is planned.',
    shape: {
      from: localDate,
      to: localDate,
      flexible_only: z
        .boolean()
        .optional()
        .describe('Only work that can move (much shorter for long ranges)')
    },
    mutates: false,
    modes: ALL,
    run: ({ from, to, flexible_only }, { db }) => {
      const start = dayStartIso(from)
      const end = toIso(Temporal.Instant.from(dayStartIso(to)).add({ hours: 24 }))
      if (minutesBetween(start, end) > 60 * 24 * 35) throw new Error('Ask for 5 weeks at most.')
      return {
        blocks: repo
          .listBlocksInRange(db, start, end)
          .filter((b) => !flexible_only || b.kind === 'flexible')
          .map(blockView),
        deadlines: repo.listDeadlines(db, start, end).map((d) => ({
          title: d.title,
          kind: d.kind,
          day: dayLabel(d.at),
          at: toLocal(d.at)
        }))
      }
    }
  }),
  def({
    name: 'find_free_slots',
    description:
      'Free time inside the availability rules (no fixed events, no other blocks, nothing in the past), day by day. Use before moving or creating blocks.',
    shape: {
      from: localDate,
      to: localDate,
      minutes: z.number().int().min(15).max(600).describe('Shortest gap worth listing'),
      ignore_block_id: z
        .string()
        .optional()
        .describe('Treat this block as free (when looking for a new time for it)')
    },
    mutates: false,
    modes: ALL,
    run: ({ from, to, minutes, ignore_block_id }, { db, now }) =>
      freeSlots(db, { from, to, minutes, exceptBlockId: ignore_block_id }, now())
  }),
  def({
    name: 'get_backlog',
    description:
      'Work that slipped: unmarked past blocks, partial or skipped blocks, unscheduled write-ups, overdue stages and todos.',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db, now }) =>
      backlog.listBacklog(db, now()).map((i) => ({
        key: i.key,
        kind: i.kind,
        title: i.title,
        detail: i.detail,
        minutes: i.minutes
      }))
  }),
  def({
    name: 'get_modules',
    description: 'Modules with write-up progress. Pass module_id for its lectures.',
    shape: { module_id: z.string().optional() },
    mutates: false,
    modes: ALL,
    run: ({ module_id }, { db, now }) => {
      if (!module_id) {
        return repo.listModules(db).map((m) => ({ id: m.id, label: m.shortLabel, name: m.name }))
      }
      const m = repo.getModuleDetail(db, module_id, now())
      if (!m) throw new Error('Module not found.')
      return {
        id: m.id,
        name: m.name,
        writtenUp: `${m.writtenUp}/${m.lecturesSoFar}`,
        lectures: m.lectures.map((l) => ({
          id: l.id,
          number: `L${l.number}`,
          ...(l.topic ? { name: l.topic } : {}),
          ...(l.kind !== 'lecture' ? { kind: l.kind } : {}),
          ...(l.topicLocked ? { namedByUser: true } : {}),
          at: toLocal(l.start),
          end: endView(l.start, l.end),
          week: l.week,
          ...(l.part ? { part: `${l.part.index} of ${l.part.of}` } : {}),
          ...(l.splitPart ? { splitFromLongerSlot: true } : {}),
          ...(l.canSplit ? { canSplit: true } : {}),
          status: l.status,
          ...(l.flashcards ? { flashcards: true } : {}),
          ...(l.notes ? { notes: true } : {}),
          writeUp: l.writeUp
            ? {
                blockId: l.writeUp.id,
                start: toLocal(l.writeUp.start),
                ...(l.writeUp.outcome !== 'none' ? { outcome: l.writeUp.outcome } : {})
              }
            : null
        }))
      }
    }
  }),
  def({
    name: 'get_module_files',
    description:
      'A module’s files: those from Moodle by section, each with the lecture it is the slides for (if any), and the user’s own files.',
    shape: { module_id: z.string() },
    mutates: false,
    modes: ALL,
    run: ({ module_id }, { db }) => {
      const groups = moodleSync.moduleMoodleFiles(db, module_id)
      const fromMoodle = new Set(groups.flatMap((g) => g.files.map((f) => f.id)))
      return {
        fromMoodle: groups.map((g) => ({
          section: g.section,
          week: g.week,
          files: g.files.map((f) => ({ id: f.id, name: f.name, lectureId: f.lectureId }))
        })),
        own: files
          .listAttachments(db, { type: 'module', id: module_id })
          .filter((f) => !fromMoodle.has(f.id))
          .map(describeFile)
      }
    }
  }),
  def({
    name: 'rename_lecture',
    description:
      'Give a lecture a name (kept like one the user typed: automatic organising won’t change it). Pass null to clear it.',
    shape: { lecture_id: z.string(), name: z.string().max(200).nullable() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id, name }, { db }) => {
      timetable.renameLecture(db, lecture_id, name)
      return { renamed: lecture_id, name }
    }
  }),
  def({
    name: 'split_lecture',
    description:
      'One timetable slot that holds two lectures: make each its own lecture (own number and write-up; later lectures are renumbered). second_starts_at is when the second one starts (HH:mm, London); half way if left out.',
    shape: {
      lecture_id: z.string(),
      second_starts_at: z
        .string()
        .regex(/^\d{2}:\d{2}$/, 'Use HH:mm')
        .optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id, second_starts_at }, { db, now }) => {
      let cuts: number[] | undefined
      if (second_starts_at) {
        const lecture = db.select().from(t.lectures).where(eq(t.lectures.id, lecture_id)).get()
        const block = lecture && getBlock(db, lecture.blockId)
        if (!block) throw new Error('Lecture not found. Use get_modules for ids.')
        const start = Temporal.Instant.from(block.start).toZonedDateTimeISO('Europe/London')
        const [h, m] = second_starts_at.split(':').map(Number)
        cuts = [h * 60 + m - (start.hour * 60 + start.minute)]
      }
      timetable.splitLecture(db, lecture_id, now(), cuts)
      return { split: lecture_id }
    }
  }),
  def({
    name: 'join_lecture',
    description: 'Undo a split: the parts of one timetable slot become one lecture again.',
    shape: { lecture_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id }, { db, now }) => {
      timetable.joinLecture(db, lecture_id, now())
      return { joined: lecture_id }
    }
  }),
  def({
    name: 'combine_lectures',
    description:
      'One lecture across sessions on different days: make lecture_id the rest of earlier_lecture_id. It shares that lecture’s number and name, and the lecture gets one write-up after its last part, sized for all parts.',
    shape: { lecture_id: z.string(), earlier_lecture_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id, earlier_lecture_id }, { db, now }) => {
      timetable.combineLectures(db, lecture_id, earlier_lecture_id, now())
      return { combined: lecture_id, into: earlier_lecture_id }
    }
  }),
  def({
    name: 'separate_lecture',
    description:
      'Undo combine_lectures: the session becomes a lecture of its own again. Given the first session of a lecture across several, every session becomes its own lecture again.',
    shape: { lecture_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id }, { db, now }) => {
      timetable.separateLecture(db, lecture_id, now())
      return { separated: lecture_id }
    }
  }),
  def({
    name: 'merge_with_previous_lecture',
    description:
      'The common case of combine_lectures: this session is the rest of the lecture just before it in its module (e.g. a lecture that ran over into the next slot).',
    shape: { lecture_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id }, { db, now }) => ({
      combined: lecture_id,
      into: timetable.mergeWithPrevious(db, lecture_id, now())
    })
  }),
  def({
    name: 'set_file_lecture',
    description:
      'Say which lecture a Moodle file is the slides (or notes) for, or null for none (it stays with its week). Kept like the user’s own choice.',
    shape: { file_id: z.string(), lecture_id: z.string().nullable() },
    mutates: true,
    modes: CHAT,
    run: ({ file_id, lecture_id }, { db }) => {
      moodleSync.setFileLecture(db, file_id, lecture_id)
      return { file: file_id, lecture: lecture_id }
    }
  }),
  def({
    name: 'get_assignments',
    description: 'Assignments by due date. Pass assignment_id for its stages and planned blocks.',
    shape: { assignment_id: z.string().optional() },
    mutates: false,
    modes: ALL,
    run: ({ assignment_id }, { db }) => {
      if (!assignment_id) {
        return assignments.listAssignments(db).map((a) => ({
          id: a.id,
          title: a.title,
          module: a.moduleLabel,
          due: toLocal(a.due),
          status: a.status,
          stages: `${a.stagesDone}/${a.stagesTotal} done`,
          logged: formatMinutes(a.loggedMinutes),
          estimate: formatMinutes(a.estimateMinutes)
        }))
      }
      const a = assignments.getAssignment(db, assignment_id)
      if (!a) throw new Error('Assignment not found.')
      return {
        id: a.id,
        title: a.title,
        due: toLocal(a.due),
        status: a.status,
        stages: a.stages.map((s) => ({
          id: s.id,
          name: s.name,
          done: s.done,
          estimateMinutes: s.estimateMinutes,
          loggedMinutes: s.loggedMinutes,
          blocks: s.blocks.map((b) => ({
            id: b.id,
            start: toLocal(b.start),
            end: toLocal(b.end),
            outcome: b.outcome
          }))
        }))
      }
    }
  }),
  def({
    name: 'get_todos',
    description: 'Open todos (and ones ticked in the last few days).',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db, now }) =>
      repo
        .listTodos(db, now())
        .map((td) => ({ id: td.id, title: td.title, done: td.done, due: td.dueDate }))
  }),
  def({
    name: 'get_record',
    description:
      'The record (session log and debriefs) for a block’s lecture/assignment/module, or for a lecture, assignment or module id. Read-only.',
    shape: {
      block_id: z.string().optional(),
      lecture_id: z.string().optional(),
      assignment_id: z.string().optional(),
      module_id: z.string().optional()
    },
    mutates: false,
    modes: ALL,
    run: (args, { db, recordsDir }) => {
      let target: RecordTarget | null = null
      if (args.block_id) target = targetForBlock(db, requireBlock(db, args.block_id))
      else if (args.lecture_id) target = { entityType: 'lecture', entityId: args.lecture_id }
      else if (args.assignment_id)
        target = { entityType: 'assignment', entityId: args.assignment_id }
      else if (args.module_id) target = { entityType: 'module', entityId: args.module_id }
      if (!target) throw new Error('Give one of block_id, lecture_id, assignment_id, module_id.')
      const path = recordPath(db, recordsDir, target)
      if (!path || !existsSync(path)) return 'No record yet (nothing has been logged).'
      const text = readFileSync(path, 'utf8')
      return text.length > 12_000 ? `…${text.slice(-12_000)}` : text
    }
  }),
  def({
    name: 'get_week_summary',
    description:
      'This week (Mon–Sun): study hours so far vs the target, and planned, done, partial and skipped blocks.',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db, now }) => weekSummary(db, now())
  }),
  def({
    name: 'get_recent_changes',
    description: 'Your recent changes (newest first), with ids for undo_change.',
    shape: {},
    mutates: false,
    modes: CHAT,
    run: (_args, { db }) =>
      recentBatches(db, 8).map((b) => ({
        id: b.id,
        when: toLocal(b.createdAt),
        request: b.request,
        status: b.status,
        changes: b.lines
      }))
  }),

  // --- Changing -----------------------------------------------------------------------------
  def({
    name: 'move_block',
    description:
      'Move (and optionally resize) one flexible block. Fixed blocks never move. The new time must be free, inside availability, not in the past, a write-up within 3 working days (Monday to Friday) of its lecture (unless the user explicitly asked for a later time: past_limit_requested), and assignment work 2 days before the deadline.',
    shape: {
      block_id: z.string(),
      start: localTime,
      end: localTime.optional().describe('Defaults to keeping the same length'),
      past_limit_requested: pastLimitRequested
    },
    mutates: true,
    modes: CHAT,
    run: ({ block_id, start, end, past_limit_requested }, { db, now }) => {
      const b = requireBlock(db, block_id)
      if (b.kind !== 'flexible') throw new Error(`“${b.title}” is fixed and never moves.`)
      if (b.outcome !== 'none') throw new Error(`“${b.title}” is already marked ${b.outcome}.`)
      const s = parseLocal(start)
      const e = end
        ? parseLocal(end)
        : toIso(Temporal.Instant.from(s).add({ minutes: minutesBetween(b.start, b.end) }))
      const placement = {
        blockId: b.id,
        start: s,
        end: e,
        linkedType: b.linkedType,
        linkedId: b.linkedId,
        type: b.type,
        lateByRequest: past_limit_requested
      }
      refuseIfProblems(placementProblems(db, placement, now()))
      const moved = moveBlock(db, b.id, s, e, 'claude')
      // A placement the assistant checked is fine: clear an old note, or say it's late on purpose.
      const late = pastWriteUpLimit(db, placement, now())
      const attention = late ? lateWriteUpNote(late) : null
      db.update(t.blocks).set({ attention }).where(eq(t.blocks.id, b.id)).run()
      return { moved: blockView({ ...moved, attention }) }
    }
  }),
  def({
    name: 'create_block',
    description:
      'Add a flexible block of study or other work. Same placement rules as move_block. Link it to a module so it gets its colour.',
    shape: {
      title: z.string().min(1).max(120),
      start: localTime,
      end: localTime,
      module_id: z.string().optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ title, start, end, module_id }, { db, now }) => {
      const s = parseLocal(start)
      const e = parseLocal(end)
      refuseIfProblems(placementProblems(db, { start: s, end: e }, now()))
      let categoryId: string | null = null
      if (module_id) {
        const m = db.select().from(t.modules).where(eq(t.modules.id, module_id)).get()
        if (!m) throw new Error('Module not found.')
        categoryId = m.categoryId
      }
      const id = `cl-${randomUUID().slice(0, 12)}`
      db.insert(t.blocks)
        .values({
          id,
          kind: 'flexible',
          type: 'other',
          title: title.trim(),
          start: s,
          end: e,
          categoryId,
          linkedType: module_id ? 'module' : null,
          linkedId: module_id ?? null,
          source: 'claude',
          detached: true
        })
        .run()
      return { created: blockView(requireBlock(db, id)) }
    }
  }),
  def({
    name: 'mark_outcome',
    description:
      'Mark a flexible block done, partial or skipped (e.g. the user says they skipped it). Only skipped works for blocks that haven’t started (it drops them). Past skipped and partial work goes to the Backlog.',
    shape: {
      block_id: z.string(),
      outcome: z.enum(['done', 'partial', 'skipped']),
      note: z.string().max(300).optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ block_id, outcome, note }, { db, recordsDir, now }) => {
      const b = requireBlock(db, block_id)
      if (
        outcome !== 'skipped' &&
        Temporal.Instant.compare(Temporal.Instant.from(b.start), now()) > 0
      ) {
        throw new Error(
          `“${b.title}” hasn’t started yet. Move it instead, or mark it skipped to drop it.`
        )
      }
      sessions.markOutcome(
        db,
        recordsDir,
        b.id,
        {
          outcome,
          note: outcome === 'done' ? note : undefined,
          debrief: outcome === 'partial' ? note : undefined
        },
        now()
      )
      return { marked: blockView(requireBlock(db, b.id)) }
    }
  }),
  def({
    name: 'schedule_backlog_item',
    description:
      'Put a Backlog item (key from get_backlog) on the calendar at a start time you found with find_free_slots. Partial work gets a half-length follow-up.',
    shape: { key: z.string(), start: localTime, past_limit_requested: pastLimitRequested },
    mutates: true,
    modes: CHAT,
    run: ({ key, start, past_limit_requested }, { db, now }) => {
      const item = backlog.listBacklog(db, now()).find((i) => i.key === key)
      if (!item) throw new Error('That item is no longer in the Backlog.')
      if (!item.minutes) throw new Error('This item can’t be scheduled directly.')
      // Already the follow-up length (half for partial work).
      const minutes = item.minutes
      const s = parseLocal(start)
      const e = toIso(Temporal.Instant.from(s).add({ minutes }))
      const source = item.blockId ? getBlock(db, item.blockId) : undefined
      const linked =
        item.lectureId && item.kind === 'unscheduled-write-up'
          ? { linkedType: 'lecture' as const, linkedId: item.lectureId }
          : { linkedType: source?.linkedType ?? null, linkedId: source?.linkedId ?? null }
      const placement = {
        blockId: item.kind === 'unmarked' ? item.blockId : undefined,
        start: s,
        end: e,
        ...linked,
        lateByRequest: past_limit_requested
      }
      refuseIfProblems(placementProblems(db, placement, now()))
      const id = backlog.scheduleBacklogItem(db, key, { start: s, minutes }, now())
      const late = pastWriteUpLimit(db, placement, now())
      if (late) {
        db.update(t.blocks)
          .set({ attention: lateWriteUpNote(late) })
          .where(eq(t.blocks.id, id))
          .run()
      }
      return { scheduled: blockView(requireBlock(db, id)) }
    }
  }),
  def({
    name: 'get_general_deadlines',
    description:
      'Deadlines that aren’t assignments (forms, applications, fees…), with ids, soonest first; done ones have done_at.',
    shape: {},
    mutates: false,
    modes: CHAT,
    run: (_args, { db }) =>
      deadlinesDomain.listGeneralDeadlines(db).map((d) => ({
        id: d.id,
        title: d.title,
        due: toLocal(d.due),
        module: d.moduleName,
        notes: d.notes,
        done_at: d.doneAt ? toLocal(d.doneAt) : null
      }))
  }),
  def({
    name: 'create_deadline',
    description:
      'Add a general deadline: anything with a due date that gets no planned work (a form, an application, a fee, or coursework the user calls a deadline). It shows on the calendar and in the countdown. When the user asks for a deadline, add it with this straight away (module only if it is obvious); don’t ask whether it should be an assignment instead.',
    shape: {
      title: z.string().min(1).max(200),
      due: localTime,
      module_id: z.string().optional(),
      notes: z.string().max(1000).optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ title, due, module_id, notes }, { db }) => ({
      created: deadlinesDomain.createDeadline(
        db,
        { title, due: parseLocal(due), moduleId: module_id ?? null, notes: notes ?? null },
        'claude'
      )
    })
  }),
  def({
    name: 'update_deadline',
    description:
      'Change a general deadline (id from get_general_deadlines), tick it done, or delete it.',
    shape: {
      deadline_id: z.string(),
      title: z.string().min(1).max(200).optional(),
      due: localTime.optional(),
      done: z.boolean().optional(),
      delete: z.boolean().optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ deadline_id, title, due, done, delete: remove }, { db, now }) => {
      if (remove) {
        deadlinesDomain.deleteDeadline(db, deadline_id, 'claude')
        return { deleted: deadline_id }
      }
      if (title !== undefined || due !== undefined) {
        deadlinesDomain.updateDeadline(
          db,
          deadline_id,
          { ...(title !== undefined ? { title } : {}), ...(due ? { due: parseLocal(due) } : {}) },
          'claude'
        )
      }
      if (done !== undefined)
        deadlinesDomain.setDeadlineDone(db, deadline_id, done, now(), 'claude')
      return { deadline: deadlinesDomain.getGeneralDeadline(db, deadline_id) }
    }
  }),
  def({
    name: 'create_todo',
    description: 'Add a small todo (no calendar time). Only when the user asks for one.',
    shape: { title: z.string().min(1).max(200), due_date: localDate.optional() },
    mutates: true,
    modes: CHAT,
    run: ({ title, due_date }, { db }) => ({
      created: createTodo(db, { title, dueDate: due_date })
    })
  }),
  def({
    name: 'update_assignment_stage',
    description:
      'Tick a stage done (or not), or change its time estimate. The assignment’s remaining work is re-planned by the scheduler.',
    shape: {
      stage_id: z.string(),
      done: z.boolean().optional(),
      estimate_minutes: z.number().int().min(15).max(6000).optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ stage_id, done, estimate_minutes }, { db, now }) => {
      assignments.updateStage(db, stage_id, { done, estimateMinutes: estimate_minutes }, now())
      const id = assignments.assignmentForStage(db, stage_id)
      return { updated: stage_id, assignment: id }
    }
  }),
  def({
    name: 'undo_change',
    description:
      'Undo one of your earlier changes (id from get_recent_changes). It fails if those blocks were changed since.',
    shape: { change_id: z.string() },
    // Undo restores rows itself; it is not a new change to review.
    mutates: false,
    modes: CHAT,
    run: ({ change_id }, { db, now }) => {
      undoBatch(db, change_id, now())
      return { undone: change_id }
    }
  }),

  // --- Files ----------------------------------------------------------------------------------
  def({
    name: 'list_files',
    description:
      'Files the user has added to Engram: name, what each is attached to, and whether its text can be read. Filter to one item, or to unfiled files (dropped in a chat and not placed yet).',
    shape: {
      unfiled_only: z.boolean().optional(),
      target_type: z.enum(ATTACHMENT_TARGETS).optional(),
      target_id: z.string().optional()
    },
    mutates: false,
    modes: ALL,
    run: ({ unfiled_only, target_type, target_id }, { db }) => {
      const list =
        target_type && target_id
          ? files.listAttachments(db, { type: target_type, id: target_id })
          : files.listAll(db, !!unfiled_only)
      return list.slice(0, 50).map(describeFile)
    }
  }),
  def({
    name: 'read_file',
    description:
      'The text of an attached file (Word, PDF, RTF, Pages or text), to work out what it is, which item it belongs to, and the dates, deadlines, requirements or structure it states for planning. Use it only to organise: never summarise, paraphrase, explain or answer its content.',
    shape: { file_id: z.string() },
    mutates: false,
    modes: ALL,
    run: async ({ file_id }, { db, filesDir }) => {
      const file = files.getAttachment(db, file_id)
      if (!file) throw new Error('File not found.')
      const text = await files.readAttachmentText(db, filesDir, file_id, 40_000)
      return `${file.name} (for organising only; don't summarise it):\n"""\n${text}\n"""`
    }
  }),
  def({
    name: 'attach_file',
    description:
      'Attach a file to the item it belongs to: an assignment, a module, the dissertation (target_id "main"), a dissertation section or a supervisor meeting. Get ids from get_assignments, get_modules or get_dissertation. If you can’t tell where it belongs, ask instead.',
    shape: {
      file_id: z.string(),
      target_type: z.enum(ATTACHMENT_TARGETS),
      target_id: z.string()
    },
    mutates: true,
    modes: CHAT,
    run: ({ file_id, target_type, target_id }, { db }) => {
      const file = files.setTarget(db, file_id, { type: target_type, id: target_id })
      return { attached: file.name, to: file.targetLabel }
    }
  }),
  def({
    name: 'save_pasted_brief',
    description:
      'The user pasted or typed a brief (or marking criteria) into the chat: keep exactly their text as a .txt file on the assignment or module it belongs to, so Plan from brief and Summarise brief can use it. Never write or change the text yourself.',
    shape: {
      text: z.string().min(1),
      name: z.string().max(80).describe('A short file name, e.g. "PHAR0003 lab report brief"'),
      target_type: z.enum(ATTACHMENT_TARGETS),
      target_id: z.string()
    },
    mutates: true,
    modes: CHAT,
    run: ({ text, name, target_type, target_id }, { db, filesDir }) => {
      const file = files.addText(
        db,
        filesDir,
        name,
        text,
        { type: target_type, id: target_id },
        'claude'
      )
      return { saved: file.name, id: file.id, to: file.targetLabel }
    }
  }),
  def({
    name: 'plan_assignment_from_brief',
    description:
      'Open "Plan from brief" in the app for a brief or marking-criteria file: Engram reads it and suggests the assignment’s details and stages, which the user checks and saves. Pass assignment_id to re-plan an existing assignment; leave it out for a new one. Use this rather than creating stages yourself.',
    shape: { file_id: z.string(), assignment_id: z.string().optional() },
    mutates: false,
    modes: CHAT,
    run: ({ file_id, assignment_id }, { db, planBrief }) => {
      const file = files.getAttachment(db, file_id)
      if (!file) throw new Error('File not found.')
      if (!file.readable) throw new Error(`Text can’t be read from “${file.name}”.`)
      if (assignment_id && !assignments.getAssignment(db, assignment_id)) {
        throw new Error('Assignment not found.')
      }
      planBrief(file_id, assignment_id ?? null)
      return 'Opened “Plan from brief” for the user to check. They save it themselves.'
    }
  }),

  // --- Dissertation ---------------------------------------------------------------------------
  def({
    name: 'get_dissertation',
    description:
      'The dissertation plan: sections (status, word counts, reading, planned sessions), milestones, submission and viva dates, reading list status and the latest meeting’s action items.',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db, now }) => {
      const o = dissertation.getOverview(db, now())
      const latest = o.meetings[0]
      return {
        title: o.settings.title,
        submissionDue: o.settings.submissionDue ? toLocal(o.settings.submissionDue) : null,
        viva: o.settings.vivaDate,
        words: `${o.wordCount}${o.settings.wordTarget ? ` / ${o.settings.wordTarget}` : ''}`,
        sections: o.sections.map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          words: s.wordCount,
          wordTarget: s.wordTarget,
          reading: s.readingCount,
          logged: formatMinutes(s.loggedMinutes),
          planned: s.upcoming.map((b) => toLocal(b.start))
        })),
        milestones: o.milestones.map((m) => ({
          id: m.id,
          title: m.title,
          due: m.due,
          done: !!m.doneAt
        })),
        reading: o.reading
          .filter((r) => !r.missing)
          .map((r) => ({
            id: r.id,
            ref: `${r.creators}${r.year ? ` (${r.year})` : ''}`,
            title: r.title,
            status: r.status,
            sections: r.sectionIds
          })),
        meetings: o.meetings.slice(0, 5).map((m) => ({ id: m.id, at: toLocal(m.at) })),
        latestMeeting: latest
          ? {
              at: toLocal(latest.at),
              actions: latest.actions.map((a) => ({ text: a.text, done: a.done }))
            }
          : null
      }
    }
  }),
  def({
    name: 'update_dissertation_section',
    description:
      'Change a section’s status (not-started, reading, drafting, drafted, revised) or its word count (as the user reports it).',
    shape: {
      section_id: z.string(),
      status: z.enum(SECTION_STATUSES).optional(),
      word_count: z.number().int().min(0).max(100000).optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ section_id, status, word_count }, { db }) => {
      dissertation.updateSection(db, section_id, { status, wordCount: word_count })
      return { updated: section_id }
    }
  }),
  def({
    name: 'update_milestone',
    description: 'Tick a dissertation milestone done (or not), or move its date (YYYY-MM-DD).',
    shape: { milestone_id: z.string(), done: z.boolean().optional(), due: localDate.optional() },
    mutates: true,
    modes: CHAT,
    run: ({ milestone_id, done, due }, { db, now }) => {
      dissertation.updateMilestone(db, milestone_id, { done, due }, now())
      return { updated: milestone_id }
    }
  }),
  def({
    name: 'update_reading',
    description:
      'Set a reading-list item’s status (to-read, read, notes-done) or the sections it is used in.',
    shape: {
      item_id: z.string(),
      status: z.enum(READING_STATUSES).optional(),
      section_ids: z.array(z.string()).optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ item_id, status, section_ids }, { db }) => {
      dissertation.updateReading(db, item_id, { status, sectionIds: section_ids })
      return { updated: item_id }
    }
  }),
  def({
    name: 'schedule_dissertation_session',
    description:
      'Put a work session on a dissertation section on the calendar, at a time found with find_free_slots.',
    shape: {
      section_id: z.string(),
      start: localTime,
      minutes: z.number().int().min(15).max(240)
    },
    mutates: true,
    modes: CHAT,
    run: ({ section_id, start, minutes }, { db, now }) => {
      const s = parseLocal(start)
      const e = toIso(Temporal.Instant.from(s).add({ minutes }))
      refuseIfProblems(placementProblems(db, { start: s, end: e }, now()))
      const id = dissertation.scheduleSession(db, section_id, { minutes, start: s }, now())
      return { scheduled: blockView(requireBlock(db, id)) }
    }
  }),

  // --- Debriefs and check-ins ---------------------------------------------------------------
  def({
    name: 'save_debrief',
    description:
      'Save the debrief for the partial block being discussed: what was covered, what is left, anything to note. Use the user’s words; a few short lines.',
    shape: { text: z.string().min(1).max(4000) },
    mutates: true,
    modes: ['debrief'],
    run: ({ text }, { db, recordsDir, now, mode }) => {
      if (mode.kind !== 'debrief') throw new Error('Not in a debrief.')
      sessions.saveDebrief(db, recordsDir, mode.blockId, text, now())
      return { saved: true }
    }
  }),
  def({
    name: 'suggest_todos',
    description:
      'Offer loose ends from the debrief as todos. They are only created if the user approves each one in the panel.',
    shape: {
      todos: z
        .array(z.object({ title: z.string().min(1).max(200), due_date: localDate.optional() }))
        .min(1)
        .max(5)
    },
    mutates: false,
    modes: ['debrief'],
    run: ({ todos }, { suggest }) => {
      suggest(
        todos.map((td) => ({
          id: randomUUID().slice(0, 8),
          title: td.title,
          dueDate: td.due_date ?? null
        }))
      )
      return 'Shown to the user for approval.'
    }
  }),
  def({
    name: 'complete_checkin',
    description:
      'Finish the timed-out session being discussed: its outcome and, if the user says when they really stopped, the corrected end time.',
    shape: {
      outcome: z.enum(['done', 'partial', 'skipped']),
      end: localTime.optional().describe('When they actually stopped, if different'),
      note: z.string().max(300).optional(),
      debrief: z
        .string()
        .max(4000)
        .optional()
        .describe('For partial: what was covered and what is left')
    },
    mutates: true,
    modes: ['checkin'],
    run: ({ outcome, end, note, debrief }, { db, recordsDir, now, mode }) => {
      if (mode.kind !== 'checkin') throw new Error('Not in a check-in.')
      sessions.completeSession(
        db,
        recordsDir,
        mode.sessionId,
        { outcome, note, debrief },
        { correctedEnd: end ? parseLocal(end) : undefined, now: now() }
      )
      return { completed: true }
    }
  }),
  // --- Everything else the app's pages can change (asked for by the user) --------------------
  // Todos
  def({
    name: 'update_todo',
    description: 'Rename a todo or change its due date (null clears it).',
    shape: {
      todo_id: z.string(),
      title: z.string().min(1).max(200).optional(),
      due_date: localDate.nullable().optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ todo_id, title, due_date }, { db }) => {
      updateTodo(db, todo_id, {
        ...(title !== undefined ? { title } : {}),
        ...(due_date !== undefined ? { dueDate: due_date } : {})
      })
      return { updated: todo_id }
    }
  }),
  def({
    name: 'tick_todo',
    description: 'Tick a todo done, or un-tick it.',
    shape: { todo_id: z.string(), done: z.boolean() },
    mutates: true,
    modes: CHAT,
    run: ({ todo_id, done }, { db, now }) => ({
      todo: todo_id,
      done,
      next: setTodoDone(db, todo_id, done, now())
    })
  }),
  def({
    name: 'archive_todo',
    description: 'Archive a todo (it leaves the list; only when the user asks).',
    shape: { todo_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ todo_id }, { db }) => {
      archiveTodo(db, todo_id)
      return { archived: todo_id }
    }
  }),

  // Calendar events
  def({
    name: 'update_event',
    description:
      'Change an event the user (or you) added: title, notes, or its times. Timetabled, series and planned blocks are changed in their own ways (move_block, update_series).',
    shape: {
      block_id: z.string(),
      title: z.string().min(1).max(120).optional(),
      start: localTime.optional(),
      end: localTime.optional(),
      notes: z.string().max(2000).nullable().optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ block_id, title, start, end, notes }, { db }) => {
      const b = requireBlock(db, block_id)
      const updated = updateBlock(
        db,
        block_id,
        {
          title: title ?? b.title,
          start: start ? parseLocal(start) : b.start,
          end: end ? parseLocal(end) : b.end,
          kind: b.kind,
          moduleId: b.linkedType === 'module' ? b.linkedId : null,
          notes: notes === undefined ? b.notes : notes
        },
        'claude'
      )
      return { updated: blockView(updated) }
    }
  }),
  def({
    name: 'delete_event',
    description:
      'Delete a block, only when the user asks: an event, one occurrence of a series, a lecture’s write-up (the lecture then gets none), an assignment work session (its stage’s estimate drops by that time) or a review session. Not timetabled events. Say what else changed (the result’s note).',
    shape: { block_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ block_id }, { db, now }) => {
      const note = removeBlock(db, block_id, now(), 'claude')
      return { deleted: block_id, note }
    }
  }),
  def({
    name: 'remove_occurrence',
    description:
      'Remove one occurrence of a weekly series (e.g. not working one Saturday). The rest stays.',
    shape: { block_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ block_id }, { db }) => {
      removeOccurrence(db, block_id, 'claude')
      return { removed: block_id }
    }
  }),
  def({
    name: 'update_series',
    description:
      'Change a weekly series (e.g. the pub shift): its day and times, from now on. Pass one of its blocks.',
    shape: {
      block_id: z.string(),
      weekday: z.number().int().min(1).max(7).optional().describe('1 = Monday … 7 = Sunday'),
      start_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      end_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ block_id, weekday, start_time, end_time }, { db, now }) => {
      const b = requireBlock(db, block_id)
      if (!b.recurrenceId) throw new Error('That block isn’t part of a series.')
      const rec = getRecurrence(db, b.recurrenceId)!
      const rule = {
        ...rec.rule,
        byWeekday: weekday ? [weekday] : rec.rule.byWeekday,
        startTime: start_time ?? rec.rule.startTime,
        endTime: end_time ?? rec.rule.endTime
      }
      return { series: updateRecurrence(db, rec.id, rule, now(), 'claude') }
    }
  }),
  def({
    name: 'set_availability',
    description:
      'Change when work may be placed, for the given weekdays: start and end (HH:mm), or null to keep that day free. Days not listed stay as they are.',
    shape: {
      days: z
        .array(
          z.object({
            weekday: z.number().int().min(1).max(7),
            start: z
              .string()
              .regex(/^\d{2}:\d{2}$/)
              .nullable(),
            end: z
              .string()
              .regex(/^\d{2}:\d{2}$/)
              .nullable()
          })
        )
        .min(1)
    },
    mutates: true,
    modes: CHAT,
    run: ({ days }, { db }) => {
      const av = getAvailability(db)
      const next = [...av.days]
      for (const d of days)
        next[d.weekday - 1] = d.start && d.end ? { start: d.start, end: d.end } : null
      return { availability: setAvailability(db, { days: next }) }
    }
  }),

  // Assignments
  def({
    name: 'create_assignment',
    description:
      'Add an assignment (its work is planned in stages by the scheduler). Prefer plan_assignment_from_brief when there is a brief.',
    shape: {
      module_id: z.string(),
      title: z.string().min(1).max(200),
      due: localTime,
      type: z.enum(ASSIGNMENT_TYPES),
      estimate_hours: z.number().min(0.5).max(200),
      plan_now: z
        .boolean()
        .describe('Put its work on the calendar now; ask the user if they haven’t said'),
      weighting: z.number().int().min(0).max(100).optional(),
      word_limit: z.number().int().min(1).max(100000).optional()
    },
    mutates: true,
    modes: CHAT,
    run: (a, { db, now }) => ({
      created: assignments.createAssignment(
        db,
        {
          moduleId: a.module_id,
          title: a.title,
          due: parseLocal(a.due),
          type: a.type,
          weighting: a.weighting ?? null,
          wordLimit: a.word_limit ?? null,
          estimateMinutes: Math.round(a.estimate_hours * 60),
          planned: a.plan_now
        },
        now()
      )
    })
  }),
  def({
    name: 'update_assignment',
    description:
      'Change an assignment’s details: title, due date and time, type, weighting, word limit, notes or summary.',
    shape: {
      assignment_id: z.string(),
      title: z.string().min(1).max(200).optional(),
      due: localTime.optional(),
      type: z.enum(ASSIGNMENT_TYPES).optional(),
      weighting: z.number().int().min(0).max(100).nullable().optional(),
      word_limit: z.number().int().min(1).max(100000).nullable().optional(),
      notes: z.string().max(4000).nullable().optional(),
      summary: z.string().max(2000).nullable().optional()
    },
    mutates: true,
    modes: CHAT,
    run: (a, { db, now }) => {
      assignments.updateAssignment(
        db,
        a.assignment_id,
        {
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.due !== undefined ? { due: parseLocal(a.due) } : {}),
          ...(a.type !== undefined ? { type: a.type } : {}),
          ...(a.weighting !== undefined ? { weighting: a.weighting } : {}),
          ...(a.word_limit !== undefined ? { wordLimit: a.word_limit } : {}),
          ...(a.notes !== undefined ? { notes: a.notes } : {}),
          ...(a.summary !== undefined ? { summary: a.summary } : {})
        },
        now()
      )
      return { updated: a.assignment_id }
    }
  }),
  def({
    name: 'set_assignment_total_time',
    description:
      'Change an assignment’s total time in hours: the stages not done yet are rescaled in proportion, and the work is re-planned.',
    shape: { assignment_id: z.string(), hours: z.number().min(0.25).max(200) },
    mutates: true,
    modes: CHAT,
    run: ({ assignment_id, hours }, { db, now }) => {
      assignments.setTotalEstimate(db, assignment_id, Math.round(hours * 60), now())
      return { assignment: assignment_id, totalHours: hours }
    }
  }),
  def({
    name: 'set_assignment_planned',
    description:
      'Put an assignment’s work on the calendar (planned: true) or take all its future blocks off (false; nothing is planned until it’s turned back on).',
    shape: { assignment_id: z.string(), planned: z.boolean() },
    mutates: true,
    modes: CHAT,
    run: ({ assignment_id, planned }, { db, now }) => {
      assignments.setPlanned(db, assignment_id, planned, now())
      return { assignment: assignment_id, planned }
    }
  }),
  def({
    name: 'set_assignment_submitted',
    description: 'Mark an assignment submitted (its remaining planned work is cleared), or not.',
    shape: { assignment_id: z.string(), submitted: z.boolean() },
    mutates: true,
    modes: CHAT,
    run: ({ assignment_id, submitted }, { db, now }) => {
      assignments.setSubmitted(db, assignment_id, submitted, now())
      return { assignment: assignment_id, submitted }
    }
  }),
  def({
    name: 'delete_assignment',
    description:
      'Delete an assignment and its planned future work. Only when the user asks to delete it.',
    shape: { assignment_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ assignment_id }, { db, now }) => {
      assignments.deleteAssignment(db, assignment_id, now())
      return { deleted: assignment_id }
    }
  }),
  def({
    name: 'add_assignment_stage',
    description: 'Add a stage to an assignment (at the end); its time is planned by the scheduler.',
    shape: {
      assignment_id: z.string(),
      name: z.string().min(1).max(120),
      estimate_minutes: z.number().int().min(15).max(6000)
    },
    mutates: true,
    modes: CHAT,
    run: ({ assignment_id, name, estimate_minutes }, { db, now }) => ({
      added: assignments.addStage(
        db,
        assignment_id,
        { name, estimateMinutes: estimate_minutes },
        now()
      )
    })
  }),
  def({
    name: 'remove_assignment_stage',
    description: 'Remove a stage from an assignment (its untouched future blocks go too).',
    shape: { stage_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ stage_id }, { db, now }) => {
      assignments.removeStage(db, stage_id, now())
      return { removed: stage_id }
    }
  }),
  def({
    name: 'move_assignment_stage',
    description: 'Move a stage earlier or later in its assignment’s order.',
    shape: { stage_id: z.string(), direction: z.enum(['earlier', 'later']) },
    mutates: true,
    modes: CHAT,
    run: ({ stage_id, direction }, { db, now }) => {
      assignments.moveStage(db, stage_id, direction === 'earlier' ? -1 : 1, now())
      return { moved: stage_id, direction }
    }
  }),

  // Modules and lectures
  def({
    name: 'update_module',
    description:
      'Change a module’s settings: name, short label, colour (#rrggbb), write-up minutes per hour of lecture, or whether lectures are organised automatically.',
    shape: {
      module_id: z.string(),
      name: z.string().min(1).max(120).optional(),
      short_label: z.string().min(1).max(8).optional(),
      colour: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      write_up_minutes_per_hour: z.number().int().min(15).max(480).optional(),
      auto_organise: z.boolean().optional()
    },
    mutates: true,
    modes: CHAT,
    run: (m, { db, now }) => {
      timetable.updateModule(
        db,
        m.module_id,
        {
          ...(m.name !== undefined ? { name: m.name } : {}),
          ...(m.short_label !== undefined ? { shortLabel: m.short_label } : {}),
          ...(m.colour !== undefined ? { colour: m.colour } : {}),
          ...(m.write_up_minutes_per_hour !== undefined
            ? { writeUpMinutes: m.write_up_minutes_per_hour }
            : {}),
          ...(m.auto_organise !== undefined ? { autoOrganise: m.auto_organise } : {})
        },
        now()
      )
      return { updated: m.module_id }
    }
  }),
  def({
    name: 'set_lecture_attended',
    description: 'Mark a past lecture as attended (the default) or missed.',
    shape: { lecture_id: z.string(), attended: z.boolean() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id, attended }, { db }) => {
      timetable.setAttended(db, lecture_id, attended)
      return { lecture: lecture_id, attended }
    }
  }),
  def({
    name: 'set_lecture_flashcards',
    description: 'Tick (or untick) that flashcards were made for a lecture.',
    shape: { lecture_id: z.string(), made: z.boolean() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id, made }, { db, now }) => {
      timetable.setFlashcards(db, lecture_id, made, now())
      return { lecture: lecture_id, flashcards: made }
    }
  }),
  def({
    name: 'set_lecture_notes',
    description: 'Tick (or untick) that the user made notes for a lecture.',
    shape: { lecture_id: z.string(), made: z.boolean() },
    mutates: true,
    modes: CHAT,
    run: ({ lecture_id, made }, { db, now }) => {
      timetable.setNotes(db, lecture_id, made, now())
      return { lecture: lecture_id, notes: made }
    }
  }),
  def({
    name: 'delete_timetable_event',
    description:
      'Take a timetabled event (a lecture, practical, workshop…) off the calendar for good: later timetable imports leave it out (the user can restore it in Settings). Its untouched write-up goes too. Only when the user asks.',
    shape: { block_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ block_id }, { db, now }) => {
      timetable.hideTimetableBlock(db, block_id, now())
      return { deleted: block_id }
    }
  }),

  // Dissertation
  def({
    name: 'update_dissertation_settings',
    description:
      'Change the dissertation’s title, submission deadline, the user’s viva date and time, or word target.',
    shape: {
      title: z.string().min(1).max(300).optional(),
      submission_due: localTime.nullable().optional(),
      viva_date: localDate.nullable().optional(),
      viva_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .nullable()
        .optional(),
      word_target: z.number().int().min(100).max(100000).nullable().optional()
    },
    mutates: true,
    modes: CHAT,
    run: (d, { db }) => ({
      settings: dissertation.updateSettings(db, {
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.submission_due !== undefined
          ? { submissionDue: d.submission_due ? parseLocal(d.submission_due) : null }
          : {}),
        ...(d.viva_date !== undefined ? { vivaDate: d.viva_date } : {}),
        ...(d.viva_time !== undefined ? { vivaTime: d.viva_time } : {}),
        ...(d.word_target !== undefined ? { wordTarget: d.word_target } : {})
      })
    })
  }),
  def({
    name: 'add_dissertation_section',
    description: 'Add a section to the dissertation plan (at the end).',
    shape: {
      title: z.string().min(1).max(200),
      word_target: z.number().int().min(1).max(100000).optional()
    },
    mutates: true,
    modes: CHAT,
    run: ({ title, word_target }, { db }) => ({
      added: dissertation.addSection(db, title, word_target ?? null)
    })
  }),
  def({
    name: 'remove_dissertation_section',
    description: 'Remove a section from the dissertation plan. Only when the user asks.',
    shape: { section_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ section_id }, { db }) => {
      dissertation.removeSection(db, section_id)
      return { removed: section_id }
    }
  }),
  def({
    name: 'add_milestone',
    description: 'Add a dissertation milestone with its due date.',
    shape: { title: z.string().min(1).max(200), due: localDate },
    mutates: true,
    modes: CHAT,
    run: ({ title, due }, { db }) => ({ added: dissertation.addMilestone(db, title, due) })
  }),
  def({
    name: 'remove_milestone',
    description: 'Remove a dissertation milestone. Only when the user asks.',
    shape: { milestone_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ milestone_id }, { db }) => {
      dissertation.removeMilestone(db, milestone_id)
      return { removed: milestone_id }
    }
  }),
  def({
    name: 'save_meeting',
    description:
      'Record a supervisor meeting (or change one, with meeting_id): when, the user’s notes as they gave them, and action items (each becomes a todo due a week later).',
    shape: {
      meeting_id: z.string().optional(),
      at: localTime,
      notes: z.string().max(10000),
      actions: z.array(z.string().min(1).max(200)).max(20)
    },
    mutates: true,
    modes: CHAT,
    run: ({ meeting_id, at, notes, actions }, { db }) => ({
      saved: dissertation.saveMeeting(db, { id: meeting_id, at: parseLocal(at), notes, actions })
    })
  }),
  def({
    name: 'remove_meeting',
    description: 'Delete a supervisor meeting. Only when the user asks.',
    shape: { meeting_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ meeting_id }, { db }) => {
      dissertation.removeMeeting(db, meeting_id)
      return { removed: meeting_id }
    }
  }),

  // Revision
  def({
    name: 'get_reviews',
    description: 'Spaced-repetition reviews: what’s due and coming up, by lecture.',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db, now }) => reviewsDomain.revisionOverview(db, now())
  }),
  def({
    name: 'reschedule_review',
    description: 'Find a new time for a review (the next free 30 minutes near its due date).',
    shape: { review_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ review_id }, { db, now }) => ({
      block: reviewsDomain.rescheduleReview(db, review_id, now())
    })
  }),

  // The user's week
  def({
    name: 'get_week_settings',
    description:
      'The weekly target, regular commitments (e.g. a pub shift), start date and availability.',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db }) => ({ ...setup.getSetupState(db), availability: getAvailability(db) })
  }),
  def({
    name: 'set_weekly_target',
    description: 'Set the weekly self-study target in hours (null for none).',
    shape: { hours: z.number().min(1).max(100).nullable() },
    mutates: true,
    modes: CHAT,
    run: ({ hours }, { db }) => {
      setup.setWeeklyTarget(db, hours === null ? null : Math.round(hours * 60))
      return { weeklyTargetHours: hours }
    }
  }),
  def({
    name: 'add_commitment',
    description:
      'Add a weekly fixed commitment from this week on (e.g. a pub shift, Saturday 17:00–00:00).',
    shape: {
      title: z.string().min(1).max(80),
      kind: z.enum(['work', 'social']),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1),
      start_time: z.string().regex(/^\d{2}:\d{2}$/),
      end_time: z.string().regex(/^\d{2}:\d{2}$/)
    },
    mutates: true,
    modes: CHAT,
    run: (c, { db, now }) => ({
      added: setup.addCommitment(
        db,
        {
          title: c.title,
          kind: c.kind,
          byWeekday: c.weekdays,
          startTime: c.start_time,
          endTime: c.end_time
        },
        now()
      )
    })
  }),
  def({
    name: 'create_repeating_event',
    description:
      'Add an event that repeats every week (e.g. a weekly lab meeting, a society, a gym session), from its first date on the given weekdays (default: that date’s weekday) until a date or for good. Fixed unless it is study time Engram may move.',
    shape: {
      title: z.string().min(1).max(120),
      start: localTime.describe('The first occurrence’s start, YYYY-MM-DDTHH:mm London time'),
      end: localTime.describe('The first occurrence’s end'),
      weekdays: z.array(z.number().int().min(1).max(7)).optional(),
      until: localDate.optional(),
      kind: z.enum(['fixed', 'flexible']).default('fixed'),
      module_id: z.string().optional()
    },
    mutates: true,
    modes: CHAT,
    run: (c, { db, now }) => ({
      created: blockView(
        createRecurringEvent(
          db,
          {
            title: c.title,
            start: parseLocal(c.start),
            end: parseLocal(c.end),
            kind: c.kind,
            moduleId: c.module_id ?? null,
            repeat: { byWeekday: c.weekdays ?? [], until: c.until ?? null }
          },
          'claude',
          now()
        )
      )
    })
  }),
  def({
    name: 'end_series_after',
    description:
      'Stop a repeating event (any series: a weekly commitment, a repeating event the user added) after the given occurrence, which becomes the last. Later occurrences nobody touched are removed. Only when the user asks.',
    shape: { block_id: z.string().describe('The occurrence that should be the last') },
    mutates: true,
    modes: CHAT,
    run: ({ block_id }, { db }) => {
      endSeriesAfter(db, block_id, 'claude')
      return { endedAfter: block_id }
    }
  }),
  def({
    name: 'end_commitment',
    description:
      'Stop a weekly commitment from today (its future untouched occurrences go). Only when the user asks.',
    shape: { commitment_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ commitment_id }, { db, now }) => {
      setup.endCommitment(db, commitment_id, now())
      return { ended: commitment_id }
    }
  }),
  def({
    name: 'set_start_date',
    description:
      'The day the user started with Engram (YYYY-MM-DD, or null): lectures before it get no write-up and wait in the Backlog.',
    shape: { date: localDate.nullable() },
    mutates: true,
    modes: CHAT,
    run: ({ date }, { db, now }) => {
      timetable.setStartDate(db, date, now())
      return { startDate: date }
    }
  }),

  // Backlog and logged time
  def({
    name: 'dismiss_backlog_item',
    description:
      'Let go of a partly done or skipped block in the Backlog (it won’t be rescheduled). Only when the user asks.',
    shape: { key: z.string().describe('The item’s key from get_backlog') },
    mutates: true,
    modes: CHAT,
    run: ({ key }, { db, now }) => {
      backlog.dismissBacklogItem(db, key, now())
      return { dismissed: key }
    }
  }),
  def({
    name: 'log_time',
    description:
      'Log study time the user did without a timer (counts towards the week). Optionally for a module or a lecture.',
    shape: {
      start: localTime,
      minutes: z
        .number()
        .int()
        .min(5)
        .max(12 * 60),
      module_id: z.string().optional(),
      lecture_id: z.string().optional(),
      note: z.string().max(500).optional()
    },
    mutates: true,
    modes: CHAT,
    run: (a, { db, recordsDir, now }) => ({
      logged: sessions.addManualTime(
        db,
        recordsDir,
        {
          start: parseLocal(a.start),
          minutes: a.minutes,
          link: a.lecture_id
            ? { type: 'lecture', id: a.lecture_id }
            : a.module_id
              ? { type: 'module', id: a.module_id }
              : null,
          note: a.note
        },
        now()
      )
    })
  }),

  // --- Finding, stats and notifications -----------------------------------------------------
  def({
    name: 'find',
    description:
      'Find anything by name: modules, lectures ("L12", a topic), assignments, deadlines, todos, files, dissertation sections, reading, and calendar events from 2 weeks ago to 2 months ahead. Every word must match. Use it to get ids when the user names something.',
    shape: { query: z.string().min(1).max(100) },
    mutates: false,
    modes: ALL,
    run: ({ query }, { db, now }) => {
      const found = findItems(db, query, now())
      return found.length ? found : 'Nothing matches. Try fewer or different words.'
    }
  }),
  def({
    name: 'get_stats',
    description:
      'Study time over a range (week, 4w, 12w or all): total and weekly average vs the target, by module and by type, the last 12 weeks, how planned work went, and how assignment estimates compared with the time logged.',
    shape: { range: z.enum(['week', '4w', '12w', 'all']).default('4w') },
    mutates: false,
    modes: ALL,
    run: ({ range }, { db, now }) => {
      const s = statsOverview(db, range, now())
      return {
        from: s.from,
        total: formatMinutes(s.totalMinutes),
        perWeek: formatMinutes(s.averagePerWeek),
        weeklyTarget: s.weekTargetMinutes ? formatMinutes(s.weekTargetMinutes) : null,
        byModule: s.byModule
          .filter((m) => m.minutes > 0)
          .map((m) => `${m.label}: ${formatMinutes(m.minutes)}`),
        byType: s.byType
          .filter((x) => x.minutes > 0)
          .map((x) => `${x.type}: ${formatMinutes(x.minutes)}`),
        weeks: s.weeks.map((w) => `${w.weekStart}: ${formatMinutes(w.minutes)}`),
        planned: {
          ...s.planned,
          plannedTime: formatMinutes(s.planned.plannedMinutes),
          loggedTime: formatMinutes(s.planned.loggedMinutes)
        },
        estimates: s.estimates
      }
    }
  }),
  def({
    name: 'get_notifications',
    description:
      'What’s waiting for the user: pending debriefs and check-ins, overdue todos, important Moodle forum posts (announcements and staff posts that may change plans), and Moodle briefs that came in without a matching assignment.',
    shape: {},
    mutates: false,
    modes: ALL,
    run: (_args, { db, now }) => ({
      waiting: backlog.listNotifications(db, now()).map((n) => ({
        kind: n.kind,
        title: n.title,
        detail: n.detail
      })),
      forumPosts: forums.pendingForumPosts(db).map((p) => ({
        module: p.label,
        forum: p.forum,
        title: p.title ?? p.subject,
        kind: p.kind,
        author: p.author,
        at: toLocal(new Date(p.created * 1000).toISOString())
      })),
      briefsWithoutAssignment: moodleSync.pendingBriefs(db).map((b) => ({
        title: b.title,
        fileId: b.attachmentId
      }))
    })
  }),
  def({
    name: 'organise_lectures',
    description:
      'Run Organise lectures for a module now (as on its page): reads its timetable lectures, lecture list and Moodle files, names lectures and tags slides. Names and files the user set are kept. Splits it finds are only suggested on the module page. Takes up to a minute.',
    shape: { module_id: z.string() },
    mutates: true,
    modes: CHAT,
    run: async ({ module_id }, { db, filesDir, now, completeJson }) => {
      if (!completeJson) throw new Error('Organising isn’t available here.')
      const status = await organiseModule(db, filesDir, module_id, completeJson, now(), {
        force: true
      })
      if (!status) return 'Nothing to organise: the module has no lectures yet.'
      return {
        lectureList: status.listName,
        named: status.named,
        slidesTagged: status.tagged,
        splitsSuggested: status.splits.length,
        continuationsSuggested: status.continuations?.length ?? 0
      }
    }
  }),

  // --- Time off -----------------------------------------------------------------------------
  def({
    name: 'take_time_off',
    description:
      'Clear whole days (ill, a trip, a day off): adds a fixed “Time off” block over each day’s available hours so nothing is planned there, and moves the flexible work on those days to the first times that follow every rule. Timetabled teaching stays. Work that can’t move within its limit stays put and is listed in notMoved: tell the user and ask what to do.',
    shape: {
      from: localDate,
      to: localDate,
      title: z.string().max(60).optional().describe('Defaults to “Time off”, e.g. “Ill”')
    },
    mutates: true,
    modes: CHAT,
    run: ({ from, to, title }, { db, now }) => takeTimeOff(db, { from, to, title }, now())
  }),

  // --- Memory -------------------------------------------------------------------------------
  def({
    name: 'remember',
    description:
      'Save a lasting preference about how the user likes to plan (e.g. “No write-ups after 21:00”, “Essays in the mornings”). Short, in the user’s terms. It is shown in every conversation and in Settings → Claude.',
    shape: { text: z.string().min(1).max(MEMORY_TEXT_MAX) },
    mutates: true,
    modes: CHAT,
    run: ({ text }, { db, now }) => ({ remembered: addMemory(db, text, now()) })
  }),
  def({
    name: 'forget',
    description:
      'Remove something you were asked to remember (id from the list in your instructions).',
    shape: { id: z.string() },
    mutates: true,
    modes: CHAT,
    run: ({ id }, { db }) => ({ forgot: removeMemory(db, id).text })
  })
]

export function toolsFor(mode: ConversationMode): ToolDef[] {
  return TOOLS.filter((td) => td.modes.includes(mode.kind))
}

/** Hours vs target and how this week's blocks went (also feeds the Sunday review). */
export function weekSummary(db: Db, now: Temporal.Instant) {
  const week = weekRange(now)
  const summary = repo.getTodaySummary(db, now)
  const blocks = repo
    .listBlocksInRange(db, toIso(week.start), toIso(week.end))
    .filter((b) => b.kind === 'flexible')
  const count = (o: Block['outcome']) => blocks.filter((b) => b.outcome === o).length
  const past = blocks.filter(
    (b) => Temporal.Instant.compare(Temporal.Instant.from(b.end), now) <= 0
  )
  return {
    week: `${dayLabel(toIso(week.start))} – ${dayLabel(toIso(week.end.subtract({ days: 1 })))}`,
    studied: formatMinutes(summary.weekMinutes),
    target: summary.weekTargetMinutes ? formatMinutes(summary.weekTargetMinutes) : null,
    blocks: {
      planned: blocks.length,
      done: count('done'),
      partial: count('partial'),
      skipped: count('skipped'),
      unmarkedPast: past.filter((b) => b.outcome === 'none').length
    },
    slipped: blocks
      .filter((b) => b.outcome === 'partial' || b.outcome === 'skipped')
      .map((b) => `${b.title} (${b.outcome}, ${dayLabel(b.start)})`)
  }
}
