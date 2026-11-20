import { randomUUID } from 'crypto'
import { and, eq, gt } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type { Commitment, CommitmentInput, SetupState } from '../shared/types'
import { toIso, todayLocalDate } from '../core/time'
import { ensureOccurrences, logChange, validateRule } from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { getStartDate } from './timetable'

// The setup wizard's own settings (Phase 10): the start date (see timetable.ts), the weekly
// target, regular commitments such as a work shift (weekly series of fixed blocks) and whether
// setup has been finished. Everything else the wizard shows lives in its own module.

const COMMITMENT_CATEGORIES = {
  work: { name: 'Work', shortLabel: 'WORK', colour: '#7b93bd', type: 'pub-shift' },
  social: { name: 'Social', shortLabel: 'SOC', colour: '#3ec867', type: 'social' }
} as const

const setting = <T>(db: Db, key: string): T | null =>
  (db.select().from(t.settings).where(eq(t.settings.key, key)).get()?.value as T) ?? null

function putSetting(db: Db, key: string, value: unknown): void {
  if (value === null) {
    db.delete(t.settings).where(eq(t.settings.key, key)).run()
    return
  }
  db.insert(t.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

export function getSetupState(db: Db): SetupState {
  return {
    startDate: getStartDate(db),
    weeklyTargetMinutes: setting<number>(db, 'weeklyTargetMinutes'),
    completedAt: setting<{ completedAt: string }>(db, 'setup')?.completedAt ?? null,
    commitments: listCommitments(db)
  }
}

export function setWeeklyTarget(db: Db, minutes: number | null): void {
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 60 || minutes > 100 * 60)) {
    throw new Error('Set a weekly target between 1 and 100 hours.')
  }
  putSetting(db, 'weeklyTargetMinutes', minutes)
}

export function completeSetup(db: Db, now: Temporal.Instant): void {
  putSetting(db, 'setup', { completedAt: toIso(now) })
  logChange(db, {
    actor: 'user',
    action: 'setup.complete',
    entityType: 'settings',
    entityId: 'setup'
  })
}

/** Weekly series of fixed blocks still running (no end date, or one in the future). */
export function listCommitments(db: Db): Commitment[] {
  const kinds = new Map(
    db
      .select()
      .from(t.categories)
      .all()
      .map((c) => [c.id, c.kind])
  )
  return db
    .select()
    .from(t.recurrences)
    .all()
    .filter((r) => r.kind === 'fixed' && !r.until)
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: (r.categoryId && kinds.get(r.categoryId) === 'social' ? 'social' : 'work') as
        'social' | 'work',
      byWeekday: r.rule.byWeekday,
      startTime: r.rule.startTime,
      endTime: r.rule.endTime
    }))
}

/** The Work or Social category, created the first time it's needed. */
function categoryFor(db: Db, kind: 'work' | 'social'): string {
  const found = db.select().from(t.categories).where(eq(t.categories.kind, kind)).get()
  if (found) return found.id
  const c = COMMITMENT_CATEGORIES[kind]
  const order = db.select().from(t.categories).all().length
  db.insert(t.categories)
    .values({
      id: kind,
      kind,
      name: c.name,
      shortLabel: c.shortLabel,
      colour: c.colour,
      sortOrder: order
    })
    .run()
  return kind
}

/** Add a weekly commitment (e.g. a pub shift, Saturday 17:00–00:00), from this week on. */
export function addCommitment(db: Db, input: CommitmentInput, now: Temporal.Instant): Commitment {
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('Give it a name, e.g. Pub shift.')
  if (title.length > 80) throw new Error('That name is too long.')
  if (input.kind !== 'work' && input.kind !== 'social') throw new Error('Invalid kind.')
  const rule = {
    freq: 'weekly' as const,
    byWeekday: [...new Set(input.byWeekday)].sort((a, b) => a - b),
    startTime: input.startTime,
    endTime: input.endTime
  }
  const invalid = validateRule(rule)
  if (invalid) throw new Error(invalid)
  const id = `rec-${randomUUID().slice(0, 12)}`
  db.transaction((tx) => {
    const categoryId = categoryFor(tx as unknown as Db, input.kind)
    tx.insert(t.recurrences)
      .values({
        id,
        title,
        kind: 'fixed',
        type: COMMITMENT_CATEGORIES[input.kind].type,
        categoryId,
        rule,
        startsOn: todayLocalDate(now).toString()
      })
      .run()
    ensureOccurrences(tx, now, id)
    logChange(tx, {
      actor: 'user',
      action: 'recurrence.create',
      entityType: 'recurrence',
      entityId: id,
      after: { title, rule }
    })
  })
  return listCommitments(db).find((c) => c.id === id)!
}

/**
 * Stop a commitment from today: future occurrences nobody has touched are removed; the past
 * (and anything marked or moved) stays.
 */
export function endCommitment(db: Db, id: string, now: Temporal.Instant): void {
  const rec = db.select().from(t.recurrences).where(eq(t.recurrences.id, id)).get()
  if (!rec) throw new Error('Not found.')
  db.transaction((tx) => {
    tx.update(t.recurrences)
      .set({ until: todayLocalDate(now).subtract({ days: 1 }).toString() })
      .where(eq(t.recurrences.id, id))
      .run()
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
    logChange(tx, {
      actor: 'user',
      action: 'recurrence.end',
      entityType: 'recurrence',
      entityId: id
    })
  })
}

/** Today's date (London), the wizard's default start date. */
export const today = (now: Temporal.Instant) => todayLocalDate(now).toString()
