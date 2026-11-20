import { randomUUID } from 'crypto'
import { and, asc, desc, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type {
  Block,
  CheckinItem,
  ManualTimeInput,
  OutcomeInput,
  RunningTimer
} from '../shared/types'
import { debriefEntry, sessionEntry } from '../core/records'
import { initialPlannedEnd, timerPhase } from '../core/timer'
import { minutesBetween, toIso, zoned } from '../core/time'
import { getBlock, logChange } from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { afterOutcome } from './reviews'
import { appendToRecord, targetForBlock, type RecordTarget } from './records'
import { setTodoDone } from './todos'
import { blockLabel } from './repo'

// Time tracking: timers, outcomes, check-ins, debriefs and manual time.
//
// A running timer is a session with no end. Every few seconds main calls `tickTimer`: at the
// planned end it asks once whether you're still working; with no answer it stops the timer at
// the planned end and leaves a check-in for next time. Stopping asks for an outcome
// (done / partial / skipped). Every finished session is appended to its record file.

const clean = (s?: string | null) => (s && s.trim() ? s.trim() : undefined)

export function getRunningTimer(db: Db): RunningTimer | null {
  const row = db
    .select({ session: t.sessions, block: t.blocks, colour: t.categories.colour })
    .from(t.sessions)
    .innerJoin(t.blocks, eq(t.sessions.blockId, t.blocks.id))
    .leftJoin(t.categories, eq(t.blocks.categoryId, t.categories.id))
    .where(isNull(t.sessions.end))
    .get()
  if (!row) return null
  return {
    sessionId: row.session.id,
    blockId: row.block.id,
    title: blockLabel(db, row.block.id, row.block.title),
    colour: row.colour,
    start: row.session.start,
    plannedEnd: row.session.plannedEnd ?? row.block.end,
    promptedAt: row.session.promptedAt
  }
}

export function startTimer(db: Db, blockId: string, now: Temporal.Instant): RunningTimer {
  const block = getBlock(db, blockId)
  if (!block) throw new Error('Block not found.')
  if (block.kind !== 'flexible') throw new Error('Timers run inside flexible blocks only.')
  if (block.outcome !== 'none') throw new Error('This block already has an outcome.')
  const running = getRunningTimer(db)
  if (running) throw new Error(`A timer is already running for “${running.title}”. Stop it first.`)
  db.insert(t.sessions)
    .values({
      id: randomUUID(),
      blockId,
      start: toIso(now),
      end: null,
      minutes: 0,
      linkedType: block.linkedType,
      linkedId: block.linkedId,
      plannedEnd: initialPlannedEnd(block, now)
    })
    .run()
  return getRunningTimer(db)!
}

/** "Still working": push the prompt back by `minutes` from now (or from the planned end, if later). */
export function extendTimer(db: Db, minutes: number, now: Temporal.Instant): RunningTimer {
  if (![5, 15, 30, 45, 60, 90, 120].includes(minutes)) throw new Error('Invalid extension.')
  const running = getRunningTimer(db)
  if (!running) throw new Error('No timer is running.')
  const base =
    Temporal.Instant.compare(Temporal.Instant.from(running.plannedEnd), now) > 0
      ? Temporal.Instant.from(running.plannedEnd)
      : now
  db.update(t.sessions)
    .set({ plannedEnd: toIso(base.add({ minutes })), promptedAt: null })
    .where(eq(t.sessions.id, running.sessionId))
    .run()
  return getRunningTimer(db)!
}

/** Stop the running timer now. The session then waits for an outcome. */
export function stopTimer(db: Db, now: Temporal.Instant): string {
  const running = getRunningTimer(db)
  if (!running) throw new Error('No timer is running.')
  const end = toIso(now)
  db.update(t.sessions)
    .set({ end, minutes: Math.max(0, minutesBetween(running.start, end)), promptedAt: null })
    .where(eq(t.sessions.id, running.sessionId))
    .run()
  return running.sessionId
}

/**
 * Called every few seconds (and at startup). Returns what happened so main can tell the UI:
 * `prompt` when "still working?" is due, `timedOut` when there was no answer.
 */
export function tickTimer(
  db: Db,
  now: Temporal.Instant
): { prompt?: RunningTimer; timedOut?: RunningTimer } {
  const running = getRunningTimer(db)
  if (!running) return {}
  const phase = timerPhase(running.plannedEnd, now)
  if (phase === 'prompt' && !running.promptedAt) {
    db.update(t.sessions)
      .set({ promptedAt: toIso(now) })
      .where(eq(t.sessions.id, running.sessionId))
      .run()
    return { prompt: getRunningTimer(db)! }
  }
  if (phase === 'timed-out') {
    // Nobody answered: stop at the planned end and ask about it on next use.
    db.update(t.sessions)
      .set({
        end: running.plannedEnd,
        minutes: Math.max(0, minutesBetween(running.start, running.plannedEnd)),
        checkinPending: true
      })
      .where(eq(t.sessions.id, running.sessionId))
      .run()
    logChange(db, {
      actor: 'system',
      action: 'timer.timeout',
      entityType: 'session',
      entityId: running.sessionId
    })
    return { timedOut: running }
  }
  return {}
}

/** Sessions that need the user: timed-out timers and stopped timers with no outcome yet. */
export function listCheckins(db: Db): CheckinItem[] {
  return db
    .select({ session: t.sessions, title: t.blocks.title, categoryName: t.categories.name })
    .from(t.sessions)
    .innerJoin(t.blocks, eq(t.sessions.blockId, t.blocks.id))
    .leftJoin(t.categories, eq(t.blocks.categoryId, t.categories.id))
    .where(and(isNotNull(t.sessions.end), isNull(t.sessions.outcome)))
    .orderBy(t.sessions.start)
    .all()
    .map(({ session, title, categoryName }) => ({
      sessionId: session.id,
      kind: session.checkinPending ? ('timed-out' as const) : ('needs-outcome' as const),
      blockId: session.blockId!,
      title: blockLabel(db, session.blockId!, title),
      categoryName,
      start: session.start,
      end: session.end!
    }))
}

/**
 * Record the outcome of a finished session (after stopping, or at a check-in, where the end
 * time can be corrected). Sets the block's outcome and appends to its record.
 */
export function completeSession(
  db: Db,
  recordsDir: string,
  sessionId: string,
  input: OutcomeInput,
  opts: { correctedEnd?: string; now?: Temporal.Instant } = {}
): void {
  validateOutcome(input)
  const session = db.select().from(t.sessions).where(eq(t.sessions.id, sessionId)).get()
  if (!session || !session.end) throw new Error('Session not found or still running.')
  if (session.outcome) throw new Error('This session already has an outcome.')
  const block = session.blockId ? getBlock(db, session.blockId) : undefined
  if (!block) throw new Error('Block not found.')

  let end = session.end
  if (opts.correctedEnd) {
    const corrected = Temporal.Instant.from(opts.correctedEnd)
    if (Temporal.Instant.compare(corrected, Temporal.Instant.from(session.start)) <= 0) {
      throw new Error('The end time must be after the start.')
    }
    const now = opts.now ?? Temporal.Now.instant()
    if (Temporal.Instant.compare(corrected, now.add({ minutes: 1 })) > 0) {
      throw new Error('The end time can’t be in the future.')
    }
    end = toIso(corrected)
  }
  const minutes = Math.max(0, minutesBetween(session.start, end))
  const debrief = input.outcome === 'partial' ? (clean(input.debrief) ?? null) : null

  db.transaction((tx) => {
    tx.update(t.sessions)
      .set({
        end,
        minutes,
        outcome: input.outcome,
        note: clean(input.note) ?? null,
        debrief,
        checkinPending: false
      })
      .where(eq(t.sessions.id, sessionId))
      .run()
    tx.update(t.blocks)
      .set({ outcome: input.outcome, debriefPending: input.outcome === 'partial' && !debrief })
      .where(eq(t.blocks.id, block.id))
      .run()
    // Work on a block made from a todo ticks the todo when done.
    if (input.outcome === 'done' && block.linkedType === 'todo' && block.linkedId) {
      setTodoDone(tx, block.linkedId, true, opts.now ?? Temporal.Now.instant())
    }
    logChange(tx, {
      actor: 'user',
      action: 'session.complete',
      entityType: 'session',
      entityId: sessionId,
      after: { outcome: input.outcome, minutes }
    })
  })

  afterOutcome(db, block.id, opts.now ?? Temporal.Now.instant())
  appendToRecord(
    db,
    recordsDir,
    targetForBlock(db, block),
    sessionEntry({
      start: session.start,
      end,
      minutes,
      outcome: input.outcome,
      blockTitle: block.title,
      planned: { start: block.start, end: block.end },
      note: clean(input.note),
      debrief,
      timedOutAt: session.checkinPending ? session.end : null
    })
  )
}

/**
 * Mark a block's outcome without having run a timer (e.g. you worked but forgot to start it).
 * Done/partial log `minutes` (default: the planned length) as a session; skipped logs nothing.
 */
export function markOutcome(
  db: Db,
  recordsDir: string,
  blockId: string,
  input: OutcomeInput & { minutes?: number },
  now: Temporal.Instant = Temporal.Now.instant()
): void {
  validateOutcome(input)
  const block = getBlock(db, blockId)
  if (!block) throw new Error('Block not found.')
  if (block.kind !== 'flexible') throw new Error('Only flexible blocks get an outcome.')
  if (block.outcome !== 'none') throw new Error('This block already has an outcome.')
  const running = getRunningTimer(db)
  if (running?.blockId === blockId) throw new Error('Stop the running timer first.')

  const planned = minutesBetween(block.start, block.end)
  const minutes = input.outcome === 'skipped' ? 0 : (input.minutes ?? planned)
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 12 * 60)
    throw new Error('Invalid time spent.')
  const start = block.start
  const end = toIso(Temporal.Instant.from(start).add({ minutes }))
  const debrief = input.outcome === 'partial' ? (clean(input.debrief) ?? null) : null

  db.transaction((tx) => {
    if (minutes > 0) {
      tx.insert(t.sessions)
        .values({
          id: randomUUID(),
          blockId,
          start,
          end,
          minutes,
          linkedType: block.linkedType,
          linkedId: block.linkedId,
          outcome: input.outcome,
          note: clean(input.note) ?? null,
          debrief
        })
        .run()
    }
    tx.update(t.blocks)
      .set({ outcome: input.outcome, debriefPending: input.outcome === 'partial' && !debrief })
      .where(eq(t.blocks.id, blockId))
      .run()
    if (input.outcome === 'done' && block.linkedType === 'todo' && block.linkedId) {
      setTodoDone(tx, block.linkedId, true, Temporal.Now.instant())
    }
    logChange(tx, {
      actor: 'user',
      action: 'block.markOutcome',
      entityType: 'block',
      entityId: blockId,
      after: { outcome: input.outcome, minutes }
    })
  })

  afterOutcome(db, block.id, now)
  appendToRecord(
    db,
    recordsDir,
    targetForBlock(db, block),
    sessionEntry({
      start,
      end: minutes ? end : null,
      minutes,
      outcome: input.outcome,
      blockTitle: block.title,
      planned: { start: block.start, end: block.end },
      note: clean(input.note),
      debrief
    })
  )
}

/** Write the debrief for a partial block that is waiting for one. */
export function saveDebrief(
  db: Db,
  recordsDir: string,
  blockId: string,
  debrief: string,
  now: Temporal.Instant
): void {
  const block = getBlock(db, blockId)
  if (!block) throw new Error('Block not found.')
  if (block.outcome !== 'partial') throw new Error('Only partial blocks have a debrief.')
  const text = clean(debrief)
  if (!text) throw new Error('Write the debrief first.')
  if (text.length > 4000) throw new Error('The debrief is too long.')
  const session = db
    .select()
    .from(t.sessions)
    .where(eq(t.sessions.blockId, blockId))
    .orderBy(desc(t.sessions.start))
    .get()
  db.transaction((tx) => {
    if (session) {
      tx.update(t.sessions).set({ debrief: text }).where(eq(t.sessions.id, session.id)).run()
    }
    tx.update(t.blocks).set({ debriefPending: false }).where(eq(t.blocks.id, blockId)).run()
  })
  appendToRecord(db, recordsDir, targetForBlock(db, block), debriefEntry(toIso(now), text))
}

/** Time spent outside any block, optionally tagged to a module or lecture. */
export function addManualTime(
  db: Db,
  recordsDir: string,
  input: ManualTimeInput,
  now: Temporal.Instant
): string {
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 12 * 60) {
    throw new Error('Time must be between 1 minute and 12 hours.')
  }
  const start = Temporal.Instant.from(input.start)
  const end = start.add({ minutes: input.minutes })
  if (Temporal.Instant.compare(end, now.add({ minutes: 1 })) > 0)
    throw new Error('Manual time can’t end in the future.')

  let target: RecordTarget = { entityType: 'other', entityId: 'other' }
  if (input.link?.type === 'lecture') {
    if (!db.select().from(t.lectures).where(eq(t.lectures.id, input.link.id)).get())
      throw new Error('Lecture not found.')
    target = { entityType: 'lecture', entityId: input.link.id }
  } else if (input.link?.type === 'module') {
    if (!db.select().from(t.modules).where(eq(t.modules.id, input.link.id)).get())
      throw new Error('Module not found.')
    target = { entityType: 'module', entityId: input.link.id }
  }

  const id = randomUUID()
  db.insert(t.sessions)
    .values({
      id,
      blockId: null,
      start: toIso(start),
      end: toIso(end),
      minutes: input.minutes,
      manual: true,
      linkedType: input.link?.type ?? null,
      linkedId: input.link?.id ?? null,
      outcome: 'done',
      note: clean(input.note) ?? null
    })
    .run()
  logChange(db, {
    actor: 'user',
    action: 'session.addManual',
    entityType: 'session',
    entityId: id,
    after: input
  })
  appendToRecord(
    db,
    recordsDir,
    target,
    sessionEntry({
      start: toIso(start),
      end: toIso(end),
      minutes: input.minutes,
      outcome: 'done',
      manual: true,
      note: clean(input.note)
    })
  )
  return id
}

function validateOutcome(input: OutcomeInput): void {
  if (!['done', 'partial', 'skipped'].includes(input.outcome)) throw new Error('Invalid outcome.')
  for (const [v, max] of [
    [input.note, 300],
    [input.debrief, 4000]
  ] as const) {
    if (v !== undefined && (typeof v !== 'string' || v.length > max)) {
      throw new Error('Text is too long.')
    }
  }
}

/**
 * The block a quick "start" (menu bar) would time: the flexible block happening now, else the
 * next one today. Only unmarked blocks count.
 */
export function startableBlock(
  db: Db,
  now: Temporal.Instant
): { block: Block; current: boolean } | null {
  const dayEnd = toIso(zoned(now).startOfDay().add({ days: 1 }))
  const candidates = db
    .select()
    .from(t.blocks)
    .where(
      and(
        eq(t.blocks.kind, 'flexible'),
        eq(t.blocks.outcome, 'none'),
        gt(t.blocks.end, toIso(now)),
        lt(t.blocks.start, dayEnd)
      )
    )
    .orderBy(asc(t.blocks.start))
    .all()
  const first = candidates[0]
  if (!first) return null
  const block = getBlock(db, first.id)!
  return { block, current: Temporal.Instant.compare(Temporal.Instant.from(first.start), now) <= 0 }
}
