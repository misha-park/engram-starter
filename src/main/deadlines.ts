import { randomUUID } from 'crypto'
import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type { Deadline, DeadlineInput, GeneralDeadline } from '../shared/types'
import { toIso } from '../core/time'
import { logChange } from './calendar'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'

// Deadlines that aren't assignments: a form, an application, a fee… Just a name and a time
// (optionally a module): they show on the Assignments page, the calendar's all-day row and
// the sidebar's countdown. Nothing is planned for them.

function validate(db: DbOrTx, input: Partial<DeadlineInput>): void {
  if (input.title !== undefined && !input.title.trim()) throw new Error('A deadline needs a name.')
  if (input.title && input.title.length > 200) throw new Error('That name is too long.')
  if (input.due !== undefined) {
    try {
      Temporal.Instant.from(input.due)
    } catch {
      throw new Error('Invalid due date.')
    }
  }
  if (input.moduleId) {
    const mod = db.select().from(t.modules).where(eq(t.modules.id, input.moduleId)).get()
    if (!mod) throw new Error('Module not found.')
  }
}

function rows(db: DbOrTx) {
  return db
    .select({
      d: t.deadlines,
      moduleName: t.categories.name,
      colour: t.categories.colour,
      categoryId: t.categories.id
    })
    .from(t.deadlines)
    .leftJoin(t.modules, eq(t.deadlines.moduleId, t.modules.id))
    .leftJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
}

const view = (r: {
  d: typeof t.deadlines.$inferSelect
  moduleName: string | null
  colour: string | null
}): GeneralDeadline => ({
  id: r.d.id,
  title: r.d.title,
  due: r.d.due,
  moduleId: r.d.moduleId,
  moduleName: r.moduleName,
  colour: r.colour,
  notes: r.d.notes,
  doneAt: r.d.doneAt
})

/** Every deadline, soonest first (done ones too: the page dims them). */
export function listGeneralDeadlines(db: DbOrTx): GeneralDeadline[] {
  return rows(db).orderBy(asc(t.deadlines.due)).all().map(view)
}

export function getGeneralDeadline(db: DbOrTx, id: string): GeneralDeadline | null {
  const r = rows(db).where(eq(t.deadlines.id, id)).get()
  return r ? view(r) : null
}

/** Open deadlines between two instants, for the calendar (like assignment deadlines). */
export function deadlinesInRange(db: DbOrTx, startIso: string, endIso: string): Deadline[] {
  return rows(db)
    .where(
      and(isNull(t.deadlines.doneAt), gt(t.deadlines.due, startIso), lt(t.deadlines.due, endIso))
    )
    .all()
    .map((r) => ({
      id: `deadline-${r.d.id}`,
      title: r.d.title,
      at: r.d.due,
      categoryId: r.categoryId,
      kind: 'deadline' as const
    }))
}

export function createDeadline(
  db: Db,
  input: DeadlineInput,
  actor: 'user' | 'claude' = 'user'
): GeneralDeadline {
  validate(db, input)
  const id = randomUUID()
  db.transaction((tx) => {
    tx.insert(t.deadlines)
      .values({
        id,
        title: input.title.trim(),
        due: toIso(Temporal.Instant.from(input.due)),
        moduleId: input.moduleId || null,
        notes: input.notes?.trim() || null
      })
      .run()
    logChange(tx, { actor, action: 'deadline.create', entityType: 'deadline', entityId: id })
  })
  return getGeneralDeadline(db, id)!
}

export function updateDeadline(
  db: Db,
  id: string,
  patch: Partial<DeadlineInput>,
  actor: 'user' | 'claude' = 'user'
): GeneralDeadline {
  if (!getGeneralDeadline(db, id)) throw new Error('Deadline not found.')
  validate(db, patch)
  const set: Partial<typeof t.deadlines.$inferInsert> = {}
  if (patch.title !== undefined) set.title = patch.title.trim()
  if (patch.due !== undefined) set.due = toIso(Temporal.Instant.from(patch.due))
  if (patch.moduleId !== undefined) set.moduleId = patch.moduleId || null
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null
  db.transaction((tx) => {
    if (Object.keys(set).length) tx.update(t.deadlines).set(set).where(eq(t.deadlines.id, id)).run()
    logChange(tx, {
      actor,
      action: 'deadline.update',
      entityType: 'deadline',
      entityId: id,
      after: patch
    })
  })
  return getGeneralDeadline(db, id)!
}

/** Tick a deadline off (or bring it back). */
export function setDeadlineDone(
  db: Db,
  id: string,
  done: boolean,
  now: Temporal.Instant,
  actor: 'user' | 'claude' = 'user'
): void {
  const row = db.select().from(t.deadlines).where(eq(t.deadlines.id, id)).get()
  if (!row) throw new Error('Deadline not found.')
  db.transaction((tx) => {
    tx.update(t.deadlines)
      .set({ doneAt: done ? (row.doneAt ?? toIso(now)) : null })
      .where(eq(t.deadlines.id, id))
      .run()
    logChange(tx, {
      actor,
      action: done ? 'deadline.done' : 'deadline.undone',
      entityType: 'deadline',
      entityId: id
    })
  })
}

/** Put a deleted deadline back as it was (same id, still ticked off if it was): Undo. */
export function restoreDeadline(
  db: Db,
  d: Pick<GeneralDeadline, 'id' | 'title' | 'due' | 'moduleId' | 'notes' | 'doneAt'>,
  actor: 'user' | 'claude' = 'user'
): void {
  validate(db, { title: d.title, due: d.due })
  if (db.select().from(t.deadlines).where(eq(t.deadlines.id, d.id)).get()) return
  // The module may have gone since; the deadline comes back without it.
  const moduleId =
    d.moduleId && db.select().from(t.modules).where(eq(t.modules.id, d.moduleId)).get()
      ? d.moduleId
      : null
  db.transaction((tx) => {
    tx.insert(t.deadlines)
      .values({
        id: d.id,
        title: d.title.trim(),
        due: toIso(Temporal.Instant.from(d.due)),
        moduleId,
        notes: d.notes,
        doneAt: d.doneAt
      })
      .run()
    logChange(tx, { actor, action: 'deadline.restore', entityType: 'deadline', entityId: d.id })
  })
}

export function deleteDeadline(db: Db, id: string, actor: 'user' | 'claude' = 'user'): void {
  const row = db.select().from(t.deadlines).where(eq(t.deadlines.id, id)).get()
  if (!row) return
  db.transaction((tx) => {
    tx.delete(t.deadlines).where(eq(t.deadlines.id, id)).run()
    logChange(tx, {
      actor,
      action: 'deadline.delete',
      entityType: 'deadline',
      entityId: id,
      before: row
    })
  })
}
