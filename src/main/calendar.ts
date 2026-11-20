import { and, asc, eq, gt, lt, ne } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { randomUUID } from 'crypto'
import type {
  AvailabilitySettings,
  Block,
  BlockLink,
  LinkedType,
  NewBlockInput,
  Recurrence,
  RecurrenceRule
} from '../shared/types'
import { availableWindow, normalizeAvailability, validateAvailability } from '../core/availability'
import { isAutoMovable, isUserMovable, validateRange } from '../core/blocks'
import { occurrenceDates, occurrenceRange } from '../core/recurrence'
import { toIso, todayLocalDate, TZ } from '../core/time'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'

// Calendar mutations. The UI (via IPC) and, from Phase 6, the assistant's tools both call
// these, so the rules live here rather than in either caller.

type Actor = 'user' | 'claude' | 'system'

/** How far ahead recurring series are materialised as blocks. */
export const RECURRENCE_HORIZON_WEEKS = 12

export function logChange(
  db: DbOrTx,
  entry: {
    actor: Actor
    action: string
    entityType: string
    entityId: string
    before?: unknown
    after?: unknown
    batchId?: string
  }
): void {
  db.insert(t.changeLog)
    .values({
      actor: entry.actor,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      batchId: entry.batchId ?? null
    })
    .run()
}

export function getBlock(db: Db, id: string): Block | undefined {
  const row = db.select().from(t.blocks).where(eq(t.blocks.id, id)).get()
  if (!row) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt, updatedAt, ...block } = row
  return block
}

/** Move and/or resize a block. It becomes detached: automatic regeneration leaves it alone. */
export function moveBlock(
  db: Db,
  id: string,
  start: string,
  end: string,
  actor: Actor = 'user'
): Block {
  const block = getBlock(db, id)
  if (!block) throw new Error('Block not found.')
  if (actor === 'user' ? !isUserMovable(block) : !isAutoMovable(block)) {
    throw new Error(
      block.source === 'timetable'
        ? 'Timetabled events come from the university feed and cannot be moved.'
        : 'Fixed events are never moved automatically.'
    )
  }
  const error = validateRange(start, end)
  if (error) throw new Error(error)

  const startIso = toIso(Temporal.Instant.from(start))
  const endIso = toIso(Temporal.Instant.from(end))
  // A note saying it was placed outside availability goes once it's moved somewhere that fits;
  // "past the write-up limit at your request" goes with any later move (Claude re-adds it).
  const clearNote =
    !!block.attention?.startsWith(LATE_WRITE_UP_NOTE) ||
    (!!block.attention?.startsWith(PLACEMENT_NOTE) && fitsAvailability(db, id, startIso, endIso))
  db.transaction((tx) => {
    tx.update(t.blocks)
      .set({
        start: startIso,
        end: endIso,
        ...(clearNote ? { attention: null } : {}),
        // Hand-edited: series edits and timetable re-imports won't move it back.
        detached: true,
        updatedAt: toIso(Temporal.Now.instant())
      })
      .where(eq(t.blocks.id, id))
      .run()
    logChange(tx, {
      actor,
      action: 'block.move',
      entityType: 'block',
      entityId: id,
      before: { start: block.start, end: block.end },
      after: { start: startIso, end: endIso }
    })
  })
  return getBlock(db, id)!
}

/** How every "placed outside your availability" note starts (write-ups, stages, reviews). */
export const PLACEMENT_NOTE = 'Placed outside your availability'

/** How the note on a write-up Claude put past its limit, because you asked, starts. */
export const LATE_WRITE_UP_NOTE = 'Past the write-up limit'

/** Whether a time is inside the day's availability and clashes with no other block. */
export function fitsAvailability(db: DbOrTx, blockId: string, start: string, end: string): boolean {
  const window = availableWindow(
    getAvailability(db),
    Temporal.Instant.from(start).toZonedDateTimeISO(TZ).toPlainDate()
  )
  if (!window) return false
  const s = Temporal.Instant.from(start)
  const e = Temporal.Instant.from(end)
  if (
    Temporal.Instant.compare(s, window.start.toInstant()) < 0 ||
    Temporal.Instant.compare(e, window.end.toInstant()) > 0
  )
    return false
  const clash = db
    .select({ id: t.blocks.id })
    .from(t.blocks)
    .where(
      and(
        lt(t.blocks.start, end),
        gt(t.blocks.end, start),
        ne(t.blocks.id, blockId),
        ne(t.blocks.outcome, 'skipped')
      )
    )
    .get()
  return !clash
}

/**
 * Clear "placed outside your availability" notes on blocks that now fit (moved by hand before
 * moves re-checked, or availability changed). Returns how many were cleared.
 */
export function clearFittingNotes(db: Db): number {
  let cleared = 0
  for (const b of db.select().from(t.blocks).all()) {
    if (!b.attention?.startsWith(PLACEMENT_NOTE)) continue
    if (!fitsAvailability(db, b.id, b.start, b.end)) continue
    db.update(t.blocks).set({ attention: null }).where(eq(t.blocks.id, b.id)).run()
    cleared++
  }
  return cleared
}

/** Whether a block's colour comes from a module (then it's set on the module, not here). */
export function isModuleWork(db: DbOrTx, block: Pick<Block, 'categoryId' | 'source'>): boolean {
  if (block.source === 'timetable') return true
  if (!block.categoryId) return false
  const cat = db.select().from(t.categories).where(eq(t.categories.id, block.categoryId)).get()
  return cat?.kind === 'module'
}

/**
 * Give a non-module block its own colour (null = back to its calendar's colour). For a block
 * in a series, the whole series changes, including occurrences still to be generated.
 */
export function setBlockColour(
  db: Db,
  id: string,
  colour: string | null,
  actor: Actor = 'user'
): void {
  const block = getBlock(db, id)
  if (!block) throw new Error('Block not found.')
  if (isModuleWork(db, block)) {
    throw new Error('Module work takes its module’s colour. Change it on the Modules page.')
  }
  if (colour !== null && !/^#[0-9a-f]{6}$/i.test(colour)) throw new Error('Invalid colour.')
  db.transaction((tx) => {
    if (block.recurrenceId) {
      tx.update(t.recurrences).set({ colour }).where(eq(t.recurrences.id, block.recurrenceId)).run()
      tx.update(t.blocks).set({ colour }).where(eq(t.blocks.recurrenceId, block.recurrenceId)).run()
    } else {
      tx.update(t.blocks).set({ colour }).where(eq(t.blocks.id, id)).run()
    }
    logChange(tx, {
      actor,
      action: 'block.colour',
      entityType: block.recurrenceId ? 'recurrence' : 'block',
      entityId: block.recurrenceId ?? id,
      before: { colour: block.colour },
      after: { colour }
    })
  })
}

export function getRecurrence(db: Db, id: string): Recurrence | undefined {
  const row = db.select().from(t.recurrences).where(eq(t.recurrences.id, id)).get()
  if (!row) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt, ...rec } = row
  return rec
}

/**
 * Create any missing occurrence blocks for every series, from today up to the horizon.
 * Never back-fills the past (after a series edit, old weeks keep what actually happened).
 * Existing occurrences (moved or not) and removed ones (exdates) are left alone.
 */
export function ensureOccurrences(db: DbOrTx, now: Temporal.Instant, onlyId?: string): number {
  const today = todayLocalDate(now)
  const horizon = today.add({ weeks: RECURRENCE_HORIZON_WEEKS })
  const series = db
    .select()
    .from(t.recurrences)
    .all()
    .filter((r) => !onlyId || r.id === onlyId)
  let created = 0
  for (const rec of series) {
    const existing = new Set(
      db
        .select({ d: t.blocks.occurrenceDate })
        .from(t.blocks)
        .where(eq(t.blocks.recurrenceId, rec.id))
        .all()
        .map((r) => r.d)
    )
    const dates = occurrenceDates(rec.rule, {
      startsOn: rec.startsOn,
      until: rec.until,
      exdates: rec.exdates,
      from: today,
      to: horizon
    })
    for (const date of dates) {
      if (existing.has(date.toString())) continue
      const { start, end } = occurrenceRange(rec.rule, date)
      db.insert(t.blocks)
        .values({
          id: `${rec.id}-${date.toString()}`,
          kind: rec.kind,
          type: rec.type,
          title: rec.title,
          start: toIso(start),
          end: toIso(end),
          categoryId: rec.categoryId,
          colour: rec.colour,
          source: 'user',
          recurrenceId: rec.id,
          occurrenceDate: date.toString()
        })
        .run()
      created++
    }
  }
  return created
}

export function validateRule(rule: RecurrenceRule): string | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/
  if (rule.freq !== 'weekly') return 'Only weekly series are supported.'
  if (rule.byWeekday.length === 0) return 'Pick at least one day.'
  if (rule.byWeekday.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'Invalid weekday.'
  if (!time.test(rule.startTime) || !time.test(rule.endTime)) return 'Invalid time.'
  if (rule.startTime === rule.endTime) return 'The start and end time cannot be the same.'
  return null
}

/**
 * Change a series' rule. Future occurrences that haven't been edited individually (and have no
 * outcome) are regenerated; past ones and individually edited ones keep their times.
 */
export function updateRecurrence(
  db: Db,
  id: string,
  rule: RecurrenceRule,
  now: Temporal.Instant,
  actor: Actor = 'user'
): Recurrence {
  const before = getRecurrence(db, id)
  if (!before) throw new Error('Series not found.')
  const error = validateRule(rule)
  if (error) throw new Error(error)
  const clean: RecurrenceRule = {
    freq: 'weekly',
    byWeekday: [...new Set(rule.byWeekday)].sort((a, b) => a - b),
    startTime: rule.startTime,
    endTime: rule.endTime
  }

  db.transaction((tx) => {
    tx.update(t.recurrences).set({ rule: clean }).where(eq(t.recurrences.id, id)).run()
    tx.delete(t.blocks)
      .where(
        and(
          eq(t.blocks.recurrenceId, id),
          gt(t.blocks.start, toIso(now)),
          eq(t.blocks.detached, false),
          eq(t.blocks.outcome, 'none')
        )
      )
      .run()
    ensureOccurrences(tx, now, id)
    logChange(tx, {
      actor,
      action: 'recurrence.update',
      entityType: 'recurrence',
      entityId: id,
      before: before.rule,
      after: clean
    })
  })
  return getRecurrence(db, id)!
}

/** The stored fields for a block added by hand, checked. */
/** The category, link and fallback name for what a hand-added event is for (`NewBlockInput.link`). */
function linkValues(
  db: Db,
  link: BlockLink | null
): {
  categoryId: string | null
  linkedType: LinkedType | null
  linkedId: string | null
  name: string | null
} {
  const categoryOf = (moduleId: string | null) =>
    moduleId
      ? (db.select().from(t.modules).where(eq(t.modules.id, moduleId)).get()?.categoryId ?? null)
      : null
  if (!link) return { categoryId: null, linkedType: null, linkedId: null, name: null }
  if (link.type === 'module') {
    const m = db.select().from(t.modules).where(eq(t.modules.id, link.id)).get()
    if (!m) throw new Error('Module not found.')
    const name =
      db.select().from(t.categories).where(eq(t.categories.id, m.categoryId)).get()?.name ?? null
    return { categoryId: m.categoryId, linkedType: 'module', linkedId: m.id, name }
  }
  if (link.type === 'deadline') {
    const dl = db.select().from(t.deadlines).where(eq(t.deadlines.id, link.id)).get()
    if (!dl) throw new Error('Deadline not found.')
    return {
      categoryId: categoryOf(dl.moduleId),
      linkedType: 'deadline',
      linkedId: dl.id,
      name: dl.title
    }
  }
  // An assignment's work belongs to a stage: the one given, or the next one not done (else the
  // last), so its time counts like the rest of the assignment's.
  const stages =
    link.type === 'assignment-stage'
      ? db.select().from(t.assignmentStages).where(eq(t.assignmentStages.id, link.id)).all()
      : db
          .select()
          .from(t.assignmentStages)
          .where(eq(t.assignmentStages.assignmentId, link.id))
          .orderBy(asc(t.assignmentStages.position))
          .all()
  const stage = stages.find((s) => !s.doneAt) ?? stages.at(-1)
  if (!stage)
    throw new Error(
      link.type === 'assignment' ? 'That assignment has no stages yet.' : 'Stage not found.'
    )
  const a = db.select().from(t.assignments).where(eq(t.assignments.id, stage.assignmentId)).get()!
  return {
    categoryId: categoryOf(a.moduleId),
    linkedType: 'assignment-stage',
    linkedId: stage.id,
    name: a.title
  }
}

function handBlockValues(db: Db, input: NewBlockInput) {
  const link =
    input.link ?? (input.moduleId ? { type: 'module' as const, id: input.moduleId } : null)
  const linked = linkValues(db, link)
  // With something chosen under For, the title may be left empty: it takes that one's name.
  const title = String(input.title ?? '').trim() || linked.name || ''
  if (!title) throw new Error('Give the event a title.')
  if (title.length > 120) throw new Error('That title is too long.')
  const invalid = validateRange(input.start, input.end)
  if (invalid) throw new Error(invalid)
  if (input.kind !== 'fixed' && input.kind !== 'flexible') throw new Error('Invalid kind.')
  return {
    kind: input.kind,
    title,
    start: toIso(Temporal.Instant.from(input.start)),
    end: toIso(Temporal.Instant.from(input.end)),
    categoryId: linked.categoryId,
    linkedType: linked.linkedType,
    linkedId: linked.linkedId,
    notes: input.notes?.trim() || null,
    // Placed by hand: automatic replanning leaves it where it is.
    detached: true
  }
}

const isHandMade = (b: Block) => !b.recurrenceId && (b.source === 'user' || b.source === 'claude')

/** Add a block from the calendar (New event, or dragging over empty time). */
export function createBlock(db: Db, input: NewBlockInput, actor: Actor = 'user'): Block {
  if (input.repeat) return createRecurringEvent(db, input, actor)
  const id = `u-${randomUUID().slice(0, 12)}`
  const values = {
    id,
    type: 'other' as const,
    source: 'user' as const,
    ...handBlockValues(db, input)
  }
  db.transaction((tx) => {
    tx.insert(t.blocks).values(values).run()
    logChange(tx, {
      actor,
      action: 'block.create',
      entityType: 'block',
      entityId: id,
      after: values
    })
  })
  return getBlock(db, id)!
}

/**
 * A new event that repeats every week (on `repeat.byWeekday`, from its date, until
 * `repeat.until` or for good): a series like the setup's weekly commitments. Returns its
 * first occurrence.
 */
export function createRecurringEvent(
  db: Db,
  input: NewBlockInput,
  actor: Actor = 'user',
  now: Temporal.Instant = Temporal.Now.instant()
): Block {
  const values = handBlockValues(db, input)
  const start = Temporal.Instant.from(values.start).toZonedDateTimeISO(TZ)
  const end = Temporal.Instant.from(values.end).toZonedDateTimeISO(TZ)
  const hhmm = (z: Temporal.ZonedDateTime) =>
    `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`
  if (start.until(end).total('hours') >= 24)
    throw new Error('A repeating event must be under a day.')
  const days = [...new Set(input.repeat?.byWeekday ?? [])].filter((d) => d >= 1 && d <= 7)
  const rule: RecurrenceRule = {
    freq: 'weekly',
    byWeekday: (days.length ? days : [start.dayOfWeek]).sort((a, b) => a - b),
    startTime: hhmm(start),
    endTime: hhmm(end)
  }
  const invalid = validateRule(rule)
  if (invalid) throw new Error(invalid)
  const startsOn = start.toPlainDate()
  const until = input.repeat?.until ? Temporal.PlainDate.from(input.repeat.until) : null
  if (until && Temporal.PlainDate.compare(until, startsOn) < 0)
    throw new Error('It can’t stop repeating before it starts.')
  const id = `rec-${randomUUID().slice(0, 12)}`
  db.transaction((tx) => {
    tx.insert(t.recurrences)
      .values({
        id,
        title: values.title,
        kind: values.kind,
        type: 'other',
        categoryId: values.categoryId,
        rule,
        startsOn: startsOn.toString(),
        until: until?.toString() ?? null
      })
      .run()
    // From the event's own date (it may be earlier this week), then up to the usual horizon.
    if (Temporal.PlainDate.compare(startsOn, todayLocalDate(now)) < 0)
      ensureOccurrences(tx, startsOn.toZonedDateTime({ timeZone: TZ }).toInstant(), id)
    ensureOccurrences(tx, now, id)
    logChange(tx, {
      actor,
      action: 'recurrence.create',
      entityType: 'recurrence',
      entityId: id,
      after: { title: values.title, rule, until: until?.toString() ?? null }
    })
  })
  const first = db
    .select()
    .from(t.blocks)
    .where(eq(t.blocks.recurrenceId, id))
    .all()
    .sort((a, b) => a.start.localeCompare(b.start))[0]
  if (!first) throw new Error('That series has no days left to repeat on.')
  return getBlock(db, first.id)!
}

/** Edit a block added by hand (or by Claude): title, times, module, kind and notes. */
export function updateBlock(
  db: Db,
  id: string,
  input: NewBlockInput,
  actor: Actor = 'user'
): Block {
  const block = getBlock(db, id)
  if (!block) throw new Error('Event not found.')
  if (!isHandMade(block)) throw new Error('Only events you added can be edited here.')
  const values = handBlockValues(db, input)
  db.transaction((tx) => {
    tx.update(t.blocks).set(values).where(eq(t.blocks.id, id)).run()
    logChange(tx, {
      actor,
      action: 'block.update',
      entityType: 'block',
      entityId: id,
      before: block,
      after: values
    })
  })
  return getBlock(db, id)!
}

/**
 * Delete a block someone added by hand (or Claude did). Timetable, recurring and planned
 * blocks are removed in their own ways; logged time stays (its session keeps no block).
 */
export function deleteBlock(db: Db, id: string, actor: Actor = 'user'): void {
  const block = getBlock(db, id)
  if (!block) return
  if (block.recurrenceId)
    throw new Error('This is part of a series: remove this one occurrence instead.')
  if (block.source !== 'user' && block.source !== 'claude') {
    throw new Error('Only events you added can be deleted.')
  }
  db.transaction((tx) => {
    tx.delete(t.blocks).where(eq(t.blocks.id, id)).run()
    logChange(tx, {
      actor,
      action: 'block.delete',
      entityType: 'block',
      entityId: id,
      before: block
    })
  })
}

/** Remove a single occurrence of a series (e.g. not working one Saturday). */
export function removeOccurrence(db: Db, blockId: string, actor: Actor = 'user'): void {
  const block = getBlock(db, blockId)
  if (!block?.recurrenceId || !block.occurrenceDate) throw new Error('Not a recurring occurrence.')
  const rec = getRecurrence(db, block.recurrenceId)!
  db.transaction((tx) => {
    tx.update(t.recurrences)
      .set({ exdates: [...new Set([...rec.exdates, block.occurrenceDate!])] })
      .where(eq(t.recurrences.id, rec.id))
      .run()
    tx.delete(t.blocks).where(eq(t.blocks.id, blockId)).run()
    logChange(tx, {
      actor,
      action: 'block.removeOccurrence',
      entityType: 'block',
      entityId: blockId,
      before: block
    })
  })
}

/**
 * Stop a series after this occurrence: it's the last one. Later occurrences nobody has
 * touched go; ones marked or moved by hand stay.
 */
export function endSeriesAfter(db: Db, blockId: string, actor: Actor = 'user'): void {
  const block = getBlock(db, blockId)
  if (!block?.recurrenceId || !block.occurrenceDate) throw new Error('Not a recurring occurrence.')
  const rec = getRecurrence(db, block.recurrenceId)!
  db.transaction((tx) => {
    tx.update(t.recurrences)
      .set({ until: block.occurrenceDate })
      .where(eq(t.recurrences.id, rec.id))
      .run()
    const later = tx
      .select({ id: t.blocks.id, date: t.blocks.occurrenceDate })
      .from(t.blocks)
      .where(
        and(
          eq(t.blocks.recurrenceId, rec.id),
          eq(t.blocks.detached, false),
          eq(t.blocks.outcome, 'none')
        )
      )
      .all()
      .filter((b) => b.date && b.date > block.occurrenceDate!)
    for (const b of later) tx.delete(t.blocks).where(eq(t.blocks.id, b.id)).run()
    logChange(tx, {
      actor,
      action: 'recurrence.end',
      entityType: 'recurrence',
      entityId: rec.id,
      before: { until: rec.until },
      after: { until: block.occurrenceDate }
    })
  })
}

export function getAvailability(db: DbOrTx): AvailabilitySettings {
  const row = db.select().from(t.settings).where(eq(t.settings.key, 'availability')).get()
  // Older databases stored one working window plus protected evenings: converted here.
  return normalizeAvailability(row?.value)
}

export function setAvailability(db: Db, av: AvailabilitySettings): AvailabilitySettings {
  const error = validateAvailability(av)
  if (error) throw new Error(error)
  const value: AvailabilitySettings = normalizeAvailability(av)
  db.insert(t.settings)
    .values({ key: 'availability', value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
  return value
}
