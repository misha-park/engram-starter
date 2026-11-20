import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as cal from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import * as bl from './backlog'
import * as repo from './repo'
import * as rv from './reviews'
import * as ses from './sessions'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00

const contexts: AppContext[] = []
function open(): { db: Db; records: string } {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-rv-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

/** A write-up later today, not done yet, for a lecture with no reviews. */
function freshWriteUp(db: Db) {
  const started = new Set(
    db
      .select()
      .from(t.reviews)
      .all()
      .map((r) => r.lectureId)
  )
  return db
    .select()
    .from(t.blocks)
    .all()
    .find(
      (b) =>
        b.type === 'write-up' &&
        b.outcome === 'none' &&
        b.start > NOW.toString() &&
        !started.has(b.linkedId!)
    )!
}

describe('spaced repetition', () => {
  it('the demo has done, overdue and planned reviews', () => {
    const { db } = open()
    const o = rv.revisionOverview(db, NOW)
    const all = o.lectures.flatMap((l) => l.reviews)
    expect(all.some((r) => r.status === 'done' && r.rating)).toBe(true)
    expect(o.due.some((r) => r.status === 'overdue' && !r.block)).toBe(true)
    expect(all.some((r) => r.status !== 'done' && r.block)).toBe(true)
    // Review blocks are 30 minutes and never show up in the Backlog.
    const block = all.find((r) => r.block)!.block!
    expect((Date.parse(block.end) - Date.parse(block.start)) / 60000).toBe(30)
    expect(bl.listBacklog(db, NOW).some((i) => i.blockId?.startsWith('rv-'))).toBe(false)
  })

  it('finishing a write-up starts its reviews; rating one plans the next from the rating', () => {
    const { db, records } = open()
    const wu = freshWriteUp(db)
    ses.markOutcome(db, records, wu.id, { outcome: 'done', minutes: 60 }, NOW)
    const first = db.select().from(t.reviews).where(eq(t.reviews.lectureId, wu.linkedId!)).all()
    expect(first).toHaveLength(1)
    expect(first[0].due).toBe('2026-11-19')
    expect(cal.getBlock(db, first[0].blockId!)!.start.startsWith('2026-11-19')).toBe(true)

    rv.rateReview(db, records, first[0].id, { rating: 'hard' }, NOW)
    expect(cal.getBlock(db, first[0].blockId!)!.outcome).toBe('done')
    const second = db
      .select()
      .from(t.reviews)
      .where(eq(t.reviews.lectureId, wu.linkedId!))
      .all()
      .find((r) => r.step === 2)!
    // Review 2 is normally +3 days; "hard" halves it (3 × 0.5 → 2), counted from today.
    expect(second.due).toBe('2026-11-20')
    expect(() => rv.rateReview(db, records, first[0].id, { rating: 'ok' }, NOW)).toThrow(/already/)

    // The heatmap shows the latest rating.
    const lecture = db.select().from(t.lectures).where(eq(t.lectures.id, wu.linkedId!)).get()!
    const detail = repo.getModuleDetail(db, lecture.moduleId, NOW)!
    expect(detail.lectures.find((l) => l.id === lecture.id)!.confidence).toBe('hard')
  })

  it('a skipped review stays open and can be planned again; done elsewhere counts as ok', () => {
    const { db, records } = open()
    const wu = freshWriteUp(db)
    ses.markOutcome(db, records, wu.id, { outcome: 'done', minutes: 60 }, NOW)
    const review = db.select().from(t.reviews).where(eq(t.reviews.lectureId, wu.linkedId!)).get()!
    ses.markOutcome(db, records, review.blockId!, { outcome: 'skipped' }, NOW)
    const open1 = db.select().from(t.reviews).where(eq(t.reviews.id, review.id)).get()!
    expect(open1.doneAt).toBeNull()
    expect(open1.blockId).toBeNull()

    const again = rv.rescheduleReview(db, review.id, NOW)
    ses.markOutcome(db, records, again, { outcome: 'done', minutes: 20 }, NOW)
    const done = db.select().from(t.reviews).where(eq(t.reviews.id, review.id)).get()!
    expect(done.doneAt).not.toBeNull()
    expect(done.rating).toBeNull()
    const next = db
      .select()
      .from(t.reviews)
      .where(eq(t.reviews.lectureId, wu.linkedId!))
      .all()
      .find((r) => r.step === 2)!
    expect(next.due).toBe('2026-11-21') // +3 days (unrated counts as ok)
  })
})
