import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { and, eq } from 'drizzle-orm'
import { recordHeader, safeName, type RecordEntity } from '../core/records'
import { formatClock, toIso } from '../core/time'
import { Temporal } from 'temporal-polyfill'
import type { DbOrTx } from './db/client'
import * as t from './db/schema'

// Record files: one Markdown file per lecture (and per module for work not tied to a
// lecture), under the profile's records folder. The path is fixed the first time the file is
// written and kept in records_index, so renumbering a lecture never moves its record.

export interface RecordTarget {
  entityType: 'lecture' | 'assignment' | 'module' | 'dissertation' | 'other'
  entityId: string
}

/** Which record a block's work belongs in: its lecture, else its module, else "other". */
export function targetForBlock(
  db: DbOrTx,
  block: { linkedType: string | null; linkedId: string | null; categoryId: string | null }
): RecordTarget {
  if (block.linkedType === 'lecture' && block.linkedId) {
    return { entityType: 'lecture', entityId: block.linkedId }
  }
  if (block.linkedType === 'assignment-stage' && block.linkedId) {
    const stage = db
      .select()
      .from(t.assignmentStages)
      .where(eq(t.assignmentStages.id, block.linkedId))
      .get()
    if (stage) return { entityType: 'assignment', entityId: stage.assignmentId }
  }
  if (block.linkedType === 'dissertation-section' && block.linkedId) {
    return { entityType: 'dissertation', entityId: block.linkedId }
  }
  if (block.categoryId) {
    const mod = db.select().from(t.modules).where(eq(t.modules.categoryId, block.categoryId)).get()
    if (mod) return { entityType: 'module', entityId: mod.id }
  }
  return { entityType: 'other', entityId: 'other' }
}

function describe(db: DbOrTx, target: RecordTarget): { relPath: string; entity: RecordEntity } {
  if (target.entityType === 'lecture') {
    const row = db
      .select({
        lecture: t.lectures,
        block: t.blocks,
        label: t.categories.shortLabel,
        name: t.categories.name
      })
      .from(t.lectures)
      .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
      .innerJoin(t.modules, eq(t.lectures.moduleId, t.modules.id))
      .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
      .where(eq(t.lectures.id, target.entityId))
      .get()
    if (row) {
      const date = Temporal.Instant.from(row.block.start)
        .toZonedDateTimeISO('Europe/London')
        .toPlainDate()
        .toLocaleString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        })
      const n = String(row.lecture.number).padStart(2, '0')
      return {
        relPath: join('modules', safeName(row.label), `L${n} ${safeName(row.block.title)}.md`),
        entity: {
          type: 'lecture',
          title: `${row.block.title} · ${row.name}`,
          intro: `Lecture: ${date}, ${formatClock(row.block.start)}–${formatClock(row.block.end)}.`
        }
      }
    }
  }
  if (target.entityType === 'assignment') {
    const row = db
      .select({ a: t.assignments, label: t.categories.shortLabel, name: t.categories.name })
      .from(t.assignments)
      .innerJoin(t.modules, eq(t.assignments.moduleId, t.modules.id))
      .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
      .where(eq(t.assignments.id, target.entityId))
      .get()
    if (row) {
      const due = Temporal.Instant.from(row.a.due).toZonedDateTimeISO('Europe/London')
      const dueText = `${due.toPlainDate().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${formatClock(row.a.due)}`
      const weighting = row.a.weighting != null ? `, ${row.a.weighting}%` : ''
      return {
        relPath: join('assignments', `${safeName(row.label)} ${safeName(row.a.title)}.md`),
        entity: {
          type: 'assignment',
          title: `${row.a.title} · ${row.name}`,
          intro: `Due ${dueText} (${row.a.type.replace('-', ' ')}${weighting}).`
        }
      }
    }
  }
  if (target.entityType === 'module') {
    const row = db
      .select({ label: t.categories.shortLabel, name: t.categories.name })
      .from(t.modules)
      .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
      .where(eq(t.modules.id, target.entityId))
      .get()
    if (row) {
      return {
        relPath: join('modules', safeName(row.label), `${safeName(row.label)} module log.md`),
        entity: {
          type: 'module',
          title: `${row.name} (${row.label})`,
          intro: 'Work on this module that is not tied to one lecture.'
        }
      }
    }
  }
  if (target.entityType === 'dissertation') {
    const row = db.select().from(t.dissSections).where(eq(t.dissSections.id, target.entityId)).get()
    if (row) {
      return {
        relPath: join('dissertation', `${safeName(row.title)}.md`),
        entity: {
          type: 'dissertation',
          title: `Dissertation: ${row.title}`,
          intro: 'Sessions and debriefs for this section. The writing itself lives in Word.'
        }
      }
    }
  }
  return {
    relPath: 'Other sessions.md',
    entity: { type: 'other', title: 'Other sessions', intro: 'Work not tied to a module.' }
  }
}

/** Append text to a target's record file, creating the file (and its index entry) if needed. */
export function appendToRecord(
  db: DbOrTx,
  recordsDir: string,
  target: RecordTarget,
  text: string
): string {
  const existing = db
    .select()
    .from(t.recordsIndex)
    .where(
      and(
        eq(t.recordsIndex.entityType, target.entityType),
        eq(t.recordsIndex.entityId, target.entityId)
      )
    )
    .get()
  const now = toIso(Temporal.Now.instant())
  let relPath = existing?.path
  if (!relPath) {
    const d = describe(db, target)
    relPath = d.relPath
    db.insert(t.recordsIndex)
      .values({
        entityType: target.entityType,
        entityId: target.entityId,
        path: relPath,
        updatedAt: now
      })
      .run()
    const full = join(recordsDir, relPath)
    mkdirSync(dirname(full), { recursive: true })
    if (!existsSync(full)) writeFileSync(full, recordHeader(d.entity))
  } else {
    db.update(t.recordsIndex)
      .set({ updatedAt: now })
      .where(eq(t.recordsIndex.id, existing!.id))
      .run()
  }
  const full = join(recordsDir, relPath)
  mkdirSync(dirname(full), { recursive: true })
  appendFileSync(full, text)
  return full
}

/** The record file path for a target, if one exists yet. */
export function recordPath(db: DbOrTx, recordsDir: string, target: RecordTarget): string | null {
  const row = db
    .select()
    .from(t.recordsIndex)
    .where(
      and(
        eq(t.recordsIndex.entityType, target.entityType),
        eq(t.recordsIndex.entityId, target.entityId)
      )
    )
    .get()
  return row ? join(recordsDir, row.path) : null
}
