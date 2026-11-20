import { randomUUID } from 'crypto'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { formatClock, toIso, zoned } from '../../core/time'
import type {
  AttachmentTarget,
  BatchStatus,
  BatchSummary,
  BlockChange,
  Outcome
} from '../../shared/types'
import { targetLabel } from '../attachments'
import type { Db } from '../db/client'
import * as t from '../db/schema'

// Change tracking for the assistant. Each tool call that changes data is wrapped: the tracked
// tables are snapshotted before and after, and the row-level differences are collected into
// the turn's batch. Undo reverses a whole batch, but only if none of its rows changed since.
// Record files are append-only logs, so lines already written to them stay.

/** Tables the assistant can change, parents before children (re-inserts go in this order). */
export const TRACKED_TABLES = [
  // Parents before children: undo re-inserts in this order and deletes in reverse.
  'categories',
  'modules',
  'settings',
  'recurrences',
  'assignments',
  'assignment_stages',
  'todos',
  'deadlines',
  'blocks',
  'lectures',
  'sessions',
  'dissertation',
  'diss_sections',
  'diss_milestones',
  'reading_items',
  'meetings',
  'meeting_actions',
  'reviews',
  'attachments',
  // Lecture organisation: splits, combined sessions, which file is which lecture's slides.
  'lecture_splits',
  'moodle_items',
  'timetable_events'
] as const
export type TrackedTable = (typeof TRACKED_TABLES)[number]

/** Each table's key column (most use `id`). */
const KEY: Partial<Record<TrackedTable, string>> = {
  settings: 'key',
  lecture_splits: 'uid',
  timetable_events: 'uid',
  moodle_items: 'key'
}
const keyOf = (table: TrackedTable) => KEY[table] ?? 'id'

/**
 * The settings the assistant can change. Other settings (sync statuses and the like) change in
 * the background and are never part of a change or its undo.
 */
const TRACKED_SETTINGS = new Set([
  'availability',
  'weeklyTargetMinutes',
  'startDate',
  'assistantMemory'
])

/** Changes to these are side effects (a lecture pointing at its write-up, a logged session). */
const SIDE_EFFECT_TABLES: readonly TrackedTable[] = ['lectures', 'sessions', 'timetable_events']

/** Columns that change on every write and don't matter when comparing rows. */
const VOLATILE_COLUMNS = new Set(['updated_at'])

type Row = Record<string, unknown>
export type Snapshot = Map<TrackedTable, Map<string, Row>>

export interface RowChange {
  table: TrackedTable
  id: string
  before: Row | null
  after: Row | null
}

const sqlite = (db: Db) => db.$client

export function snapshot(db: Db): Snapshot {
  const snap: Snapshot = new Map()
  for (const table of TRACKED_TABLES) {
    const rows = sqlite(db).prepare(`SELECT * FROM ${table}`).all() as Row[]
    const kept =
      table === 'settings' ? rows.filter((r) => TRACKED_SETTINGS.has(String(r.key))) : rows
    snap.set(table, new Map(kept.map((r) => [String(r[keyOf(table)]), r])))
  }
  return snap
}

const sameRow = (a: Row | null | undefined, b: Row | null | undefined): boolean => {
  if (!a || !b) return a === b || (!a && !b)
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (VOLATILE_COLUMNS.has(k)) continue
    if (a[k] !== b[k]) return false
  }
  return true
}

export function diff(before: Snapshot, after: Snapshot): RowChange[] {
  const changes: RowChange[] = []
  for (const table of TRACKED_TABLES) {
    const a = before.get(table)!
    const b = after.get(table)!
    for (const [id, row] of b) {
      const old = a.get(id)
      if (!old) changes.push({ table, id, before: null, after: row })
      else if (!sameRow(old, row)) changes.push({ table, id, before: old, after: row })
    }
    for (const [id, row] of a) {
      if (!b.has(id)) changes.push({ table, id, before: row, after: null })
    }
  }
  return changes
}

/**
 * Collapse several changes to the same row into one (first "before", last "after"), and drop
 * rows that ended up as they started.
 */
export function mergeChanges(changes: RowChange[]): RowChange[] {
  const byKey = new Map<string, RowChange>()
  for (const c of changes) {
    const key = `${c.table}:${c.id}`
    const prev = byKey.get(key)
    byKey.set(key, prev ? { ...prev, after: c.after } : c)
  }
  return [...byKey.values()].filter((c) => !sameRow(c.before, c.after))
}

/** Block columns the user would notice changing (not bookkeeping like backlog_resolved_at). */
const VISIBLE_BLOCK_COLUMNS = ['title', 'start', 'end', 'outcome']

/** Whether the user would see this change: not sessions, lecture links or block bookkeeping. */
export function isVisible(c: RowChange): boolean {
  if (SIDE_EFFECT_TABLES.includes(c.table)) return false
  if (c.table === 'blocks' && c.before && c.after) {
    return VISIBLE_BLOCK_COLUMNS.some((k) => c.before![k] !== c.after![k])
  }
  return true
}

/**
 * Visible changes: blocks, todos, assignments and stages (not sessions or lecture links). A
 * series counts once: adding or ending a repeating event is one change, however many
 * occurrences it adds or removes.
 */
export function visibleCount(changes: RowChange[]): number {
  const visible = changes.filter(isVisible)
  const series = new Set(visible.filter((c) => c.table === 'recurrences').map((c) => c.id))
  return visible.filter(
    (c) => !(c.table === 'blocks' && series.has(String((c.after ?? c.before)?.recurrence_id)))
  ).length
}

/** A single visible change applies straight away; anything more waits for review. */
export function isSmall(changes: RowChange[]): boolean {
  return visibleCount(changes) <= 1
}

/** Save a turn's changes as one batch. Returns null when nothing changed. */
export function recordBatch(
  db: Db,
  input: { changes: RowChange[]; request: string; conversationId: string | null },
  now: Temporal.Instant
): string | null {
  const changes = mergeChanges(input.changes)
  if (changes.length === 0) return null
  const id = `batch-${randomUUID().slice(0, 12)}`
  const status: BatchStatus = isSmall(changes) ? 'applied' : 'pending'
  db.transaction((tx) => {
    // Only the latest change can wait for review: an earlier one still waiting is kept.
    tx.update(t.assistantBatches)
      .set({ status: 'accepted', resolvedAt: toIso(now) })
      .where(eq(t.assistantBatches.status, 'pending'))
      .run()
    tx.insert(t.assistantBatches)
      .values({
        id,
        createdAt: toIso(now),
        conversationId: input.conversationId,
        request: input.request.slice(0, 500),
        status,
        changeCount: visibleCount(changes)
      })
      .run()
    for (const c of changes) {
      tx.insert(t.changeLog)
        .values({
          at: toIso(now),
          actor: 'claude',
          batchId: id,
          action: c.before && c.after ? 'row.update' : c.after ? 'row.insert' : 'row.delete',
          entityType: c.table,
          entityId: c.id,
          before: c.before,
          after: c.after
        })
        .run()
    }
  })
  return id
}

function batchChanges(db: Db, batchId: string): (RowChange & { logId: number })[] {
  return db
    .select()
    .from(t.changeLog)
    .where(and(eq(t.changeLog.batchId, batchId), isNull(t.changeLog.undoneAt)))
    .orderBy(asc(t.changeLog.id))
    .all()
    .filter((r) => r.action.startsWith('row.'))
    .map((r) => ({
      logId: r.id,
      table: r.entityType as TrackedTable,
      id: r.entityId,
      before: (r.before as Row | null) ?? null,
      after: (r.after as Row | null) ?? null
    }))
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

function readRow(db: Db, table: TrackedTable, id: string): Row | null {
  return (
    (sqlite(db)
      .prepare(`SELECT * FROM ${table} WHERE ${quote(keyOf(table))} = ?`)
      .get(id) as Row | undefined) ?? null
  )
}

function writeRow(db: Db, table: TrackedTable, row: Row): void {
  const cols = Object.keys(row)
  sqlite(db)
    .prepare(
      `INSERT OR REPLACE INTO ${table} (${cols.map(quote).join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`
    )
    .run(...cols.map((c) => row[c]))
}

function updateRow(db: Db, table: TrackedTable, row: Row): void {
  const key = keyOf(table)
  const cols = Object.keys(row).filter((c) => c !== key)
  sqlite(db)
    .prepare(
      `UPDATE ${table} SET ${cols.map((c) => `${quote(c)} = ?`).join(', ')} WHERE ${quote(key)} = ?`
    )
    .run(...cols.map((c) => row[c]), row[key])
}

/**
 * Revert a batch. Refuses (and changes nothing) if any of its rows were changed afterwards,
 * e.g. the user moved one of the blocks again.
 */
export function undoBatch(
  db: Db,
  batchId: string,
  now: Temporal.Instant,
  status: 'undone' | 'rejected' = 'undone'
): void {
  const batch = db.select().from(t.assistantBatches).where(eq(t.assistantBatches.id, batchId)).get()
  if (!batch) throw new Error('That change was not found.')
  if (batch.status === 'undone' || batch.status === 'rejected') {
    throw new Error('That change has already been undone.')
  }
  const changes = batchChanges(db, batchId)
  revertChanges(db, changes, () => {
    const at = toIso(now)
    db.update(t.changeLog)
      .set({ undoneAt: at })
      .where(and(eq(t.changeLog.batchId, batchId), isNull(t.changeLog.undoneAt)))
      .run()
    db.update(t.assistantBatches)
      .set({ status, resolvedAt: at })
      .where(eq(t.assistantBatches.id, batchId))
      .run()
  })
}

/**
 * Put rows back as they were before `changes` (refused if any changed since). `alongside`
 * runs in the same transaction.
 */
export function revertChanges(db: Db, changes: RowChange[], alongside?: () => void): void {
  const conflicts = changes.filter((c) => !sameRow(readRow(db, c.table, c.id), c.after))
  if (conflicts.length > 0) {
    const what = conflicts
      .map((c) => String((c.after ?? c.before)?.title ?? `${c.table} ${c.id}`))
      .slice(0, 3)
      .join(', ')
    throw new Error(`Can’t undo: ${what} changed since. Move it back by hand instead.`)
  }

  const order = (c: RowChange) => TRACKED_TABLES.indexOf(c.table)
  const reinserts = changes.filter((c) => c.before && !c.after).sort((a, b) => order(a) - order(b))
  const updates = changes.filter((c) => c.before && c.after)
  const deletes = changes.filter((c) => !c.before && c.after).sort((a, b) => order(b) - order(a))

  sqlite(db).transaction(() => {
    // Foreign keys are checked at commit, once every row is back in place.
    sqlite(db).pragma('defer_foreign_keys = ON')
    for (const c of reinserts) writeRow(db, c.table, c.before!)
    for (const c of updates) updateRow(db, c.table, c.before!)
    for (const c of deletes) {
      sqlite(db)
        .prepare(`DELETE FROM ${c.table} WHERE ${quote(keyOf(c.table))} = ?`)
        .run(c.id)
    }
    alongside?.()
  })()
}

/** Keep a reviewed batch as it is. */
export function acceptBatch(db: Db, batchId: string, now: Temporal.Instant): void {
  const batch = db.select().from(t.assistantBatches).where(eq(t.assistantBatches.id, batchId)).get()
  if (!batch || batch.status !== 'pending') throw new Error('Nothing is waiting for review.')
  db.update(t.assistantBatches)
    .set({ status: 'accepted', resolvedAt: toIso(now) })
    .where(eq(t.assistantBatches.id, batchId))
    .run()
}

const when = (startIso: string, endIso: string) => {
  const s = zoned(startIso)
  const day = s.toPlainDate().toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
  return `${day}, ${formatClock(startIso)}–${formatClock(endIso)}`
}

/** One readable line per visible change. */
export function describeChange(c: RowChange, db?: Db): string | null {
  if (!isVisible(c)) return null
  const row = (c.after ?? c.before)!
  const title = String(row.title ?? row.name ?? c.id)
  if (c.table === 'blocks') {
    if (!c.before) return `Added “${title}”, ${when(String(row.start), String(row.end))}`
    if (!c.after) return `Removed “${title}”`
    const b = c.before
    const a = c.after
    if (b.outcome !== a.outcome && a.outcome !== 'none') return `Marked “${title}” ${a.outcome}`
    if (b.start !== a.start || b.end !== a.end) {
      return `Moved “${title}” to ${when(String(a.start), String(a.end))}`
    }
    return `Changed “${title}”`
  }
  if (c.table === 'todos') {
    if (!c.before) return `New todo “${title}”`
    if (!c.after) return `Removed todo “${title}”`
    if (!c.before.done && c.after.done) return `Ticked todo “${title}”`
    return `Changed todo “${title}”`
  }
  if (c.table === 'assignment_stages') {
    if (!c.before?.done && c.after?.done) return `Stage “${title}” done`
    return `Changed stage “${title}”`
  }
  if (c.table === 'assignments') return `Changed assignment “${title}”`
  if (c.table === 'diss_sections') {
    if (c.before && c.after && c.before.status !== c.after.status) {
      return `Section “${title}” → ${String(c.after.status).replace('-', ' ')}`
    }
    if (c.before && c.after && c.before.word_count !== c.after.word_count) {
      return `Section “${title}”: ${String(c.after.word_count ?? 0)} words`
    }
    return `Changed section “${title}”`
  }
  if (c.table === 'diss_milestones') {
    if (!c.before?.done_at && c.after?.done_at) return `Milestone “${title}” done`
    return `Changed milestone “${title}”`
  }
  if (c.table === 'reading_items') {
    if (c.before && c.after && c.before.status !== c.after.status) {
      return `“${title}” → ${String(c.after.status).replace('-', ' ')}`
    }
    return `Changed reading “${title}”`
  }
  if (c.table === 'dissertation') return 'Changed the dissertation details'
  if (c.table === 'settings' && c.id === 'assistantMemory') {
    // Raw rows: the value is the JSON text.
    const texts = (r: Row | null) => {
      try {
        const list = r?.value ? (JSON.parse(String(r.value)) as { text: string }[]) : []
        return new Set(list.map((m) => m.text))
      } catch {
        return new Set<string>()
      }
    }
    const before = texts(c.before)
    const after = texts(c.after)
    const added = [...after].find((x) => !before.has(x))
    const removed = [...before].find((x) => !after.has(x))
    if (added) return `Remembered “${added}”`
    if (removed) return `Forgot “${removed}”`
    return 'Changed what Claude remembers'
  }
  if (c.table === 'attachments') {
    if (c.after?.target_type) {
      const label = db
        ? targetLabel(db, {
            type: c.after.target_type as AttachmentTarget,
            id: String(c.after.target_id)
          })
        : null
      return `Attached “${title}”${label ? ` to ${label}` : ''}`
    }
    return `Unfiled “${title}”`
  }
  return null
}

/** Lines for the visible changes; a turn with only side effects gets one line for those. */
function describeAll(changes: RowChange[], db?: Db): string[] {
  const lines = changes.map((c) => describeChange(c, db)).filter((l): l is string => l !== null)
  if (lines.length) return lines
  const debriefed = changes.find(
    (c) => c.table === 'blocks' && c.before?.debrief_pending && !c.after?.debrief_pending
  )
  if (debriefed) return [`Saved the debrief for “${String(debriefed.after!.title)}”`]
  return changes.length ? ['Updated the records'] : []
}

const pickBlock = (row: Row | null): BlockChange['before'] =>
  row
    ? {
        title: String(row.title),
        start: String(row.start),
        end: String(row.end),
        outcome: row.outcome as Outcome
      }
    : null

export function getBatch(db: Db, batchId: string): BatchSummary | null {
  const batch = db.select().from(t.assistantBatches).where(eq(t.assistantBatches.id, batchId)).get()
  if (!batch) return null
  const changes = db
    .select()
    .from(t.changeLog)
    .where(eq(t.changeLog.batchId, batchId))
    .orderBy(asc(t.changeLog.id))
    .all()
    .map((r) => ({
      table: r.entityType as TrackedTable,
      id: r.entityId,
      before: (r.before as Row | null) ?? null,
      after: (r.after as Row | null) ?? null
    }))
  return {
    id: batch.id,
    conversationId: batch.conversationId,
    request: batch.request,
    status: batch.status,
    changeCount: batch.changeCount,
    createdAt: batch.createdAt,
    lines: describeAll(changes, db),
    blocks: changes
      .filter((c) => c.table === 'blocks' && isVisible(c))
      .map((c) => ({ blockId: c.id, before: pickBlock(c.before), after: pickBlock(c.after) }))
  }
}

/** The batch waiting for review, if any (only the latest one can be pending). */
export function pendingBatch(db: Db): BatchSummary | null {
  const row = db
    .select({ id: t.assistantBatches.id })
    .from(t.assistantBatches)
    .where(eq(t.assistantBatches.status, 'pending'))
    .orderBy(desc(t.assistantBatches.createdAt))
    .get()
  return row ? getBatch(db, row.id) : null
}

/** Recent batches, newest first (for the undo list and the undo_change tool). */
export function recentBatches(db: Db, limit = 10): BatchSummary[] {
  return db
    .select({ id: t.assistantBatches.id })
    .from(t.assistantBatches)
    .orderBy(desc(t.assistantBatches.createdAt))
    .limit(limit)
    .all()
    .map((r) => getBatch(db, r.id)!)
}

/**
 * Wraps tool calls so their changes are tracked. One tracker per assistant turn.
 */
export class ChangeTracker {
  private readonly changes: RowChange[] = []

  constructor(private readonly db: Db) {}

  /** Run `fn`, recording what it changed in the tracked tables. */
  track<T>(fn: () => T): T {
    const before = snapshot(this.db)
    const record = () => this.changes.push(...diff(before, snapshot(this.db)))
    let result: T
    try {
      result = fn()
    } catch (e) {
      record()
      throw e
    }
    // A slow tool (Organise lectures waits for Claude): its changes are what differs once it
    // settles. A background sync finishing in the meantime would be counted too; that's rare
    // and only makes the batch's undo cover a little more.
    if (result instanceof Promise) return result.finally(record) as T
    record()
    return result
  }

  get all(): RowChange[] {
    return mergeChanges(this.changes)
  }
}
