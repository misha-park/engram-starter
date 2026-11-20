import { and, eq, gt, lt } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import { toIso } from '../../core/time'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { listModules } from '../repo'
import { toLocal } from './placement'

// Finding things by name, for the assistant's `find` tool: most requests name something
// ("the anatomy practical", "L12", "the pharmacology essay") and Claude needs its id.

export interface FindResult {
  type:
    | 'module'
    | 'lecture'
    | 'assignment'
    | 'deadline'
    | 'todo'
    | 'file'
    | 'block'
    | 'diss_section'
    | 'reading'
  id: string
  label: string
  /** Where or when it is, briefly. */
  detail?: string
}

const MAX_RESULTS = 25
/** Calendar blocks are searched from this far back to this far ahead. */
const BLOCK_DAYS_BACK = 14
const BLOCK_DAYS_AHEAD = 60

/** Every word of the query appears in the text (case-insensitive). */
export function matches(query: string, text: string): boolean {
  const hay = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

export function findItems(db: Db, query: string, now: Temporal.Instant): FindResult[] {
  const q = query.trim()
  if (!q) throw new Error('Say what to look for.')
  const out: FindResult[] = []
  const add = (r: FindResult, ...text: (string | null | undefined)[]) => {
    if (matches(q, [r.label, ...text].filter(Boolean).join(' '))) out.push(r)
  }

  const modules = listModules(db)
  const moduleLabel = new Map(modules.map((m) => [m.id, m.shortLabel]))
  for (const m of modules) {
    add({ type: 'module', id: m.id, label: `${m.shortLabel} ${m.name}` }, ...m.feedNames)
  }

  const lectures = db
    .select({ lecture: t.lectures, start: t.blocks.start })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .all()
  for (const { lecture: l, start } of lectures) {
    const mod = moduleLabel.get(l.moduleId) ?? ''
    add(
      {
        type: 'lecture',
        id: l.id,
        label: `${mod} L${l.number}${l.title ? ` ${l.title}` : ''}`,
        detail: `${l.kind && l.kind !== 'lecture' ? `${l.kind}, ` : ''}${toLocal(start)}`
      },
      l.kind
    )
  }

  for (const a of db.select().from(t.assignments).all()) {
    add(
      {
        type: 'assignment',
        id: a.id,
        label: a.title,
        detail: `due ${toLocal(a.due)}${a.submittedAt ? ', submitted' : ''}`
      },
      a.moduleId ? moduleLabel.get(a.moduleId) : null,
      a.type
    )
  }

  for (const d of db.select().from(t.deadlines).all()) {
    add(
      {
        type: 'deadline',
        id: d.id,
        label: d.title,
        detail: `${toLocal(d.due)}${d.doneAt ? ', done' : ''}`
      },
      d.moduleId ? moduleLabel.get(d.moduleId) : null
    )
  }

  for (const td of db.select().from(t.todos).where(eq(t.todos.archived, false)).all()) {
    add({
      type: 'todo',
      id: td.id,
      label: td.title,
      detail: [td.done ? 'done' : 'open', td.dueDate ? `due ${td.dueDate}` : null]
        .filter(Boolean)
        .join(', ')
    })
  }

  for (const f of db.select().from(t.attachments).all()) {
    add({
      type: 'file',
      id: f.id,
      label: f.name,
      detail: f.targetType ? `attached to a ${f.targetType}` : 'not filed'
    })
  }

  for (const s of db.select().from(t.dissSections).all()) {
    add({ type: 'diss_section', id: s.id, label: s.title, detail: s.status })
  }
  for (const r of db.select().from(t.readingItems).all()) {
    add(
      { type: 'reading', id: r.id, label: r.title, detail: r.status },
      r.creators,
      r.year ? String(r.year) : null
    )
  }

  // Calendar blocks that aren't lectures (those are found as lectures above).
  const from = toIso(now.subtract({ hours: 24 * BLOCK_DAYS_BACK }))
  const to = toIso(now.add({ hours: 24 * BLOCK_DAYS_AHEAD }))
  const lectureBlocks = new Set(lectures.map((l) => l.lecture.blockId))
  const blocks = db
    .select()
    .from(t.blocks)
    .where(and(lt(t.blocks.start, to), gt(t.blocks.end, from)))
    .all()
    .filter((b) => !lectureBlocks.has(b.id))
    .sort((a, b) => a.start.localeCompare(b.start))
  for (const b of blocks) {
    add(
      { type: 'block', id: b.id, label: b.title, detail: `${toLocal(b.start)}, ${b.type}` },
      b.type
    )
  }

  return out.slice(0, MAX_RESULTS)
}
