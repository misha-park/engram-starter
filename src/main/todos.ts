import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type { Deadline, Todo, TodoInput, TodoSource } from '../shared/types'
import { nextDueDate } from '../core/todos'
import { atLocalTime, toIso, todayLocalDate, zoned } from '../core/time'
import { logChange } from './calendar'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'

// Small todos: no time slot, shown in the home sidebar. Anything with an estimate becomes a
// flexible block instead (see backlog.scheduleTodo). Tot sync (Phase 8) reads and writes these.

function validate(input: Partial<TodoInput>): void {
  if (input.title !== undefined && !input.title.trim()) throw new Error('A todo needs a title.')
  if (input.title && input.title.length > 300) throw new Error('That title is too long.')
  if (input.dueDate) {
    try {
      Temporal.PlainDate.from(input.dueDate)
    } catch {
      throw new Error('Invalid due date.')
    }
  }
  const r = input.recurrence
  if (
    r &&
    !(
      r.freq === 'daily' ||
      (r.freq === 'weekly' && (r.byWeekday ?? []).every((d) => d >= 1 && d <= 7))
    )
  ) {
    throw new Error('Invalid repeat.')
  }
}

export function getTodo(db: DbOrTx, id: string): Todo | undefined {
  const row = db.select().from(t.todos).where(eq(t.todos.id, id)).get()
  if (!row) return undefined
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    archived: row.archived,
    dueDate: row.dueDate,
    linkedType: row.linkedType,
    linkedId: row.linkedId,
    recurrence: row.recurrence ?? null,
    source: row.source
  }
}

export function createTodo(db: DbOrTx, input: TodoInput, source: TodoSource = 'app'): string {
  validate(input)
  const id = randomUUID()
  db.insert(t.todos)
    .values({
      id,
      title: input.title.trim(),
      dueDate: input.dueDate || null,
      linkedType: input.link?.type ?? null,
      linkedId: input.link?.id ?? null,
      recurrence: input.recurrence ?? null,
      source
    })
    .run()
  logChange(db, {
    actor: 'user',
    action: 'todo.create',
    entityType: 'todo',
    entityId: id,
    after: input
  })
  return id
}

export function updateTodo(db: Db, id: string, patch: Partial<TodoInput>): void {
  validate(patch)
  const before = getTodo(db, id)
  if (!before) throw new Error('Todo not found.')
  const values: Partial<typeof t.todos.$inferInsert> = {}
  if (patch.title !== undefined) values.title = patch.title.trim()
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate || null
  if (patch.link !== undefined) {
    values.linkedType = patch.link?.type ?? null
    values.linkedId = patch.link?.id ?? null
  }
  if (patch.recurrence !== undefined) values.recurrence = patch.recurrence ?? null
  db.update(t.todos).set(values).where(eq(t.todos.id, id)).run()
  logChange(db, {
    actor: 'user',
    action: 'todo.update',
    entityType: 'todo',
    entityId: id,
    before,
    after: values
  })
}

/**
 * Tick or untick a todo. Ticking a recurring todo also creates its next instance, so the
 * done one stays as history (and as a ticked line in Tot).
 */
export function setTodoDone(
  db: DbOrTx,
  id: string,
  done: boolean,
  now: Temporal.Instant
): string | null {
  const todo = getTodo(db, id)
  if (!todo) throw new Error('Todo not found.')
  if (todo.done === done) return null
  db.update(t.todos)
    .set({ done, doneAt: done ? toIso(now) : null })
    .where(eq(t.todos.id, id))
    .run()
  syncTodoBlocks(db, id, done)
  logChange(db, {
    actor: 'user',
    action: done ? 'todo.done' : 'todo.undone',
    entityType: 'todo',
    entityId: id
  })
  if (!done || !todo.recurrence) return null
  // Ticked before, unticked and ticked again: its next instance already exists (even if it's
  // been renamed or archived since), so don't make another.
  const row = db.select({ nextId: t.todos.nextId }).from(t.todos).where(eq(t.todos.id, id)).get()
  if (row?.nextId && db.select().from(t.todos).where(eq(t.todos.id, row.nextId)).get()) return null
  const next = randomUUID()
  db.insert(t.todos)
    .values({
      id: next,
      title: todo.title,
      dueDate: nextDueDate(todo.recurrence, todo.dueDate, todayLocalDate(now)),
      linkedType: todo.linkedType,
      linkedId: todo.linkedId,
      recurrence: todo.recurrence,
      source: todo.source
    })
    .run()
  db.update(t.todos).set({ nextId: next }).where(eq(t.todos.id, id)).run()
  return next
}

/**
 * A todo's blocks on the calendar follow its tick: ticking marks unmarked ones done, unticking
 * puts back the ones that were only done by the tick (no time was logged on them).
 */
function syncTodoBlocks(db: DbOrTx, todoId: string, done: boolean): void {
  const blocks = db
    .select()
    .from(t.blocks)
    .where(and(eq(t.blocks.linkedType, 'todo'), eq(t.blocks.linkedId, todoId)))
    .all()
  for (const b of blocks) {
    if (done && b.outcome === 'none') {
      db.update(t.blocks).set({ outcome: 'done' }).where(eq(t.blocks.id, b.id)).run()
    } else if (!done && b.outcome === 'done') {
      const logged = db.select().from(t.sessions).where(eq(t.sessions.blockId, b.id)).get()
      if (!logged) db.update(t.blocks).set({ outcome: 'none' }).where(eq(t.blocks.id, b.id)).run()
    }
  }
}

/**
 * Open todos with a due date between two instants, for the calendar's all-day row (with the
 * other deadlines). Each is due at the end of its day; a module's todo takes its colour.
 */
export function todosDueInRange(db: DbOrTx, startIso: string, endIso: string): Deadline[] {
  const first = zoned(startIso).toPlainDate().toString()
  const last = zoned(endIso).toPlainDate().toString()
  const categoryOf = new Map(
    db
      .select({ id: t.modules.id, categoryId: t.modules.categoryId })
      .from(t.modules)
      .all()
      .map((m) => [m.id, m.categoryId])
  )
  return db
    .select()
    .from(t.todos)
    .where(and(eq(t.todos.done, false), eq(t.todos.archived, false)))
    .all()
    .filter((r) => r.dueDate && r.dueDate >= first && r.dueDate <= last)
    .map((r) => ({
      id: `todo-${r.id}`,
      title: r.title,
      at: toIso(atLocalTime(r.dueDate!, '23:59')),
      categoryId: r.linkedType === 'module' ? (categoryOf.get(r.linkedId ?? '') ?? null) : null,
      kind: 'todo' as const
    }))
    .filter((d) => d.at > startIso && d.at < endIso)
}

/** Undo archiving: the todo is back in the list. */
export function unarchiveTodo(db: Db, id: string): void {
  if (!getTodo(db, id)) throw new Error('Todo not found.')
  db.update(t.todos).set({ archived: false }).where(eq(t.todos.id, id)).run()
  logChange(db, { actor: 'user', action: 'todo.unarchive', entityType: 'todo', entityId: id })
}

/** Hide a todo (it stays in the database; in Tot terms, a deleted unticked line). */
export function archiveTodo(db: Db, id: string): void {
  if (!getTodo(db, id)) throw new Error('Todo not found.')
  db.update(t.todos).set({ archived: true }).where(eq(t.todos.id, id)).run()
  logChange(db, { actor: 'user', action: 'todo.archive', entityType: 'todo', entityId: id })
}
