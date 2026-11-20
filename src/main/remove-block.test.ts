import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { and, eq, gt, isNotNull } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import { ChangeTracker, revertChanges } from './assistant/changes'
import { ensureWriteUp, listBacklog } from './backlog'
import { getBlock } from './calendar'
import * as t from './db/schema'
import { removeBlock } from './remove-block'
import { reconcileTimetable, setNoWriteUp } from './timetable'
import { minutesBetween } from '../core/time'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-remove-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const lectureWithWriteUp = (db: ReturnType<typeof open>) =>
  db
    .select({ l: t.lectures, wu: t.blocks })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.writeUpBlockId, t.blocks.id))
    .where(and(isNotNull(t.lectures.writeUpBlockId), gt(t.blocks.start, NOW.toString())))
    .all()[0]

describe('deleting blocks from the calendar', () => {
  it('a write-up goes for good: not placed again, not in the Backlog; Plan a write-up brings it back', () => {
    const db = open()
    const { l, wu } = lectureWithWriteUp(db)
    expect(removeBlock(db, wu.id, NOW)).toMatch(/won’t get another write-up/)
    expect(getBlock(db, wu.id)).toBeUndefined()
    reconcileTimetable(db, NOW)
    const after = db.select().from(t.lectures).where(eq(t.lectures.id, l.id)).get()!
    expect(after.noWriteUp).toBe(true)
    expect(after.writeUpBlockId).toBeNull()
    expect(listBacklog(db, NOW).some((i) => i.lectureId === l.id)).toBe(false)

    setNoWriteUp(db, l.id, false, NOW)
    const back = db.select().from(t.lectures).where(eq(t.lectures.id, l.id)).get()!
    expect(back.noWriteUp).toBe(false)
    expect(back.writeUpBlockId).not.toBeNull()
  })

  it('Show write-up session: the existing one, or a new one when there is none', () => {
    const db = open()
    const { l, wu } = lectureWithWriteUp(db)
    expect(ensureWriteUp(db, l.id, NOW)).toEqual({ blockId: wu.id, created: false })
    removeBlock(db, wu.id, NOW)
    const made = ensureWriteUp(db, l.id, NOW)
    expect(made.created).toBe(true)
    expect(getBlock(db, made.blockId)?.type).toBe('write-up')
    const after = db.select().from(t.lectures).where(eq(t.lectures.id, l.id)).get()!
    expect(after.noWriteUp).toBe(false)
    expect(after.writeUpBlockId).toBe(made.blockId)
    // A past lecture with none (e.g. before the start date) gets one at the next free time.
    const past = db
      .select({ l: t.lectures, b: t.blocks })
      .from(t.lectures)
      .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
      .all()
      .find((r) => r.b.end < NOW.toString() && r.l.writeUpBlockId && !r.l.continuesId)!
    removeBlock(db, past.l.writeUpBlockId!, NOW)
    const late = ensureWriteUp(db, past.l.id, NOW)
    expect(getBlock(db, late.blockId)!.start >= NOW.toString()).toBe(true)
  })

  it('assignment work: the stage needs that much less time', () => {
    const db = open()
    const block = db
      .select()
      .from(t.blocks)
      .where(and(eq(t.blocks.linkedType, 'assignment-stage'), gt(t.blocks.start, NOW.toString())))
      .all()
      .find((b) => b.outcome === 'none')!
    const stage = db
      .select()
      .from(t.assignmentStages)
      .where(eq(t.assignmentStages.id, block.linkedId!))
      .get()!
    const note = removeBlock(db, block.id, NOW)
    const after = db
      .select()
      .from(t.assignmentStages)
      .where(eq(t.assignmentStages.id, stage.id))
      .get()!
    const minutes = minutesBetween(block.start, block.end)
    if (stage.estimateMinutes - minutes >= 15) {
      expect(after.estimateMinutes).toBe(stage.estimateMinutes - minutes)
      expect(note).toMatch(/now needs/)
    } else {
      expect(after.doneAt).not.toBeNull()
    }
  })

  it('refuses timetabled events, and Undo puts everything back', () => {
    const db = open()
    const lecture = db.select().from(t.blocks).where(eq(t.blocks.source, 'timetable')).get()!
    expect(() => removeBlock(db, lecture.id, NOW)).toThrow(/hide/)

    const { l, wu } = lectureWithWriteUp(db)
    const tracker = new ChangeTracker(db)
    tracker.track(() => removeBlock(db, wu.id, NOW))
    revertChanges(db, tracker.all)
    expect(getBlock(db, wu.id)?.start).toBe(wu.start)
    const restored = db.select().from(t.lectures).where(eq(t.lectures.id, l.id)).get()!
    expect(restored.noWriteUp).toBe(false)
    expect(restored.writeUpBlockId).toBe(wu.id)
  })
})
