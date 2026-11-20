import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as cal from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { recordPath, targetForBlock } from './records'
import * as repo from './repo'
import * as ses from './sessions'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00

const contexts: AppContext[] = []
function open(): { db: Db; records: string } {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-ses-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const later = (minutes: number) => NOW.add({ minutes })
/** A future write-up (outcome none) to time. */
const futureWriteUp = (db: Db) =>
  db
    .select()
    .from(t.blocks)
    .all()
    .filter((b) => b.type === 'write-up' && b.outcome === 'none' && b.start > NOW.toString())
    .sort((a, b) => a.start.localeCompare(b.start))[0]
const readRecord = (db: Db, records: string, blockId: string) => {
  const path = recordPath(db, records, targetForBlock(db, cal.getBlock(db, blockId)!))
  return path && existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('a full timer cycle', () => {
  it('start → stop → done lands in the session, the block and the lecture record', () => {
    const { db, records } = open()
    const wu = futureWriteUp(db)
    ses.startTimer(db, wu.id, NOW)
    expect(ses.getRunningTimer(db)?.blockId).toBe(wu.id)
    // Running time counts towards today and the week straight away.
    const summary = repo.getTodaySummary(db, later(30))
    expect(summary.workedTodayMinutes).toBeGreaterThanOrEqual(30)
    expect(summary.unbrokenMinutes).toBe(30)

    const sessionId = ses.stopTimer(db, later(50))
    expect(ses.listCheckins(db).map((c) => [c.sessionId, c.kind])).toContainEqual([
      sessionId,
      'needs-outcome'
    ])
    ses.completeSession(db, records, sessionId, { outcome: 'done', note: 'All figures redrawn' })

    const session = db.select().from(t.sessions).where(eq(t.sessions.id, sessionId)).get()!
    expect(session).toMatchObject({ minutes: 50, outcome: 'done', note: 'All figures redrawn' })
    expect(cal.getBlock(db, wu.id)!.outcome).toBe('done')
    expect(ses.listCheckins(db).some((c) => c.sessionId === sessionId)).toBe(false)

    const record = readRecord(db, records, wu.id)
    expect(record).toMatch(/^# .* L\d+ · Cellular Neurophysiology|^# .* L\d+ · /)
    expect(record).toContain('· 50m · Done')
    expect(record).toContain('Note: All figures redrawn')
    expect(record).toContain(`Block: ${wu.title}`)
  })

  it('partial without a debrief leaves it pending; saving one clears it and appends it', () => {
    const { db, records } = open()
    const wu = futureWriteUp(db)
    ses.startTimer(db, wu.id, NOW)
    const id = ses.stopTimer(db, later(20))
    ses.completeSession(db, records, id, { outcome: 'partial' })
    expect(cal.getBlock(db, wu.id)).toMatchObject({ outcome: 'partial', debriefPending: true })
    ses.saveDebrief(db, records, wu.id, 'Covered the first half. Left: the second half.', later(25))
    expect(cal.getBlock(db, wu.id)!.debriefPending).toBe(false)
    expect(db.select().from(t.sessions).where(eq(t.sessions.id, id)).get()!.debrief).toBe(
      'Covered the first half. Left: the second half.'
    )
    expect(readRecord(db, records, wu.id)).toContain('· Debrief')
  })

  it('partial with a debrief at stop time is not left pending', () => {
    const { db, records } = open()
    const wu = futureWriteUp(db)
    ses.startTimer(db, wu.id, NOW)
    ses.completeSession(db, records, ses.stopTimer(db, later(20)), {
      outcome: 'partial',
      debrief: 'Did the intro; the rest is left.'
    })
    expect(cal.getBlock(db, wu.id)!.debriefPending).toBe(false)
  })
})

describe('the "still working?" prompt and timeout', () => {
  it('prompts once at the planned end, then stops at the planned end with a check-in', () => {
    const { db, records } = open()
    const wu = futureWriteUp(db)
    const startAt = Temporal.Instant.from(wu.start)
    const timer = ses.startTimer(db, wu.id, startAt)
    expect(timer.plannedEnd).toBe(wu.end)
    const end = Temporal.Instant.from(wu.end)

    expect(ses.tickTimer(db, end.subtract({ minutes: 1 }))).toEqual({})
    expect(ses.tickTimer(db, end).prompt?.sessionId).toBe(timer.sessionId)
    expect(ses.tickTimer(db, end.add({ minutes: 2 }))).toEqual({}) // only one prompt
    expect(ses.tickTimer(db, end.add({ minutes: 10 })).timedOut?.sessionId).toBe(timer.sessionId)

    expect(ses.getRunningTimer(db)).toBeNull()
    const s = db.select().from(t.sessions).where(eq(t.sessions.id, timer.sessionId)).get()!
    expect(s).toMatchObject({ end: wu.end, checkinPending: true, outcome: null })
    expect(ses.listCheckins(db).find((c) => c.sessionId === timer.sessionId)?.kind).toBe(
      'timed-out'
    )

    // Check-in: the user actually stopped 20 minutes earlier.
    const corrected = end.subtract({ minutes: 20 }).toString()
    ses.completeSession(
      db,
      records,
      timer.sessionId,
      { outcome: 'done' },
      { correctedEnd: corrected, now: end.add({ hours: 2 }) }
    )
    const after = db.select().from(t.sessions).where(eq(t.sessions.id, timer.sessionId)).get()!
    expect(after).toMatchObject({ checkinPending: false, outcome: 'done' })
    expect(after.end).toBe(corrected.replace('.000', ''))
    expect(readRecord(db, records, wu.id)).toContain('confirmed at check-in')
  })

  it('extending moves the prompt and allows a new one', () => {
    const { db } = open()
    const wu = futureWriteUp(db)
    const timer = ses.startTimer(db, wu.id, Temporal.Instant.from(wu.start))
    const end = Temporal.Instant.from(wu.end)
    ses.tickTimer(db, end)
    const extended = ses.extendTimer(db, 30, end.add({ minutes: 1 }))
    expect(extended.plannedEnd).toBe(end.add({ minutes: 31 }).toString())
    expect(extended.promptedAt).toBeNull()
    expect(ses.tickTimer(db, end.add({ minutes: 20 }))).toEqual({})
    expect(ses.tickTimer(db, end.add({ minutes: 31 })).prompt?.sessionId).toBe(timer.sessionId)
  })
})

describe('rules', () => {
  it('runs one timer at a time, inside flexible blocks without an outcome', () => {
    const { db } = open()
    const blocks = db.select().from(t.blocks).all()
    const lecture = blocks.find((b) => b.type === 'lecture')!
    expect(() => ses.startTimer(db, lecture.id, NOW)).toThrow(/flexible/)
    const done = blocks.find((b) => b.outcome === 'done')!
    expect(() => ses.startTimer(db, done.id, NOW)).toThrow(/outcome/)
    const wu = futureWriteUp(db)
    ses.startTimer(db, wu.id, NOW)
    const other = blocks.filter(
      (b) => b.type === 'write-up' && b.outcome === 'none' && b.id !== wu.id
    )[0]
    expect(() => ses.startTimer(db, other.id, NOW)).toThrow(/already running/)
  })

  it('rejects a corrected end before the start', () => {
    const { db, records } = open()
    const wu = futureWriteUp(db)
    ses.startTimer(db, wu.id, NOW)
    const id = ses.stopTimer(db, later(30))
    expect(() =>
      ses.completeSession(
        db,
        records,
        id,
        { outcome: 'done' },
        { correctedEnd: NOW.subtract({ minutes: 5 }).toString(), now: later(60) }
      )
    ).toThrow(/after the start/)
  })
})

describe('without a timer', () => {
  it('marking done logs the planned time; skipped logs nothing but is recorded', () => {
    const { db, records } = open()
    const before = repo.getTodaySummary(db, NOW).weekMinutes
    const [a, b] = db
      .select()
      .from(t.blocks)
      .all()
      .filter((x) => x.type === 'write-up' && x.outcome === 'none')
      .slice(0, 2)
    ses.markOutcome(db, records, a.id, { outcome: 'done', minutes: 40 })
    expect(cal.getBlock(db, a.id)!.outcome).toBe('done')
    expect(
      db.select().from(t.sessions).where(eq(t.sessions.blockId, a.id)).all().at(-1)!.minutes
    ).toBe(40)
    ses.markOutcome(db, records, b.id, { outcome: 'skipped' })
    expect(cal.getBlock(db, b.id)!.outcome).toBe('skipped')
    expect(readRecord(db, records, b.id)).toContain('· Skipped')
    expect(repo.getTodaySummary(db, NOW).weekMinutes).toBeGreaterThanOrEqual(before)
  })

  it('manual time counts towards the week and lands in the tagged record', () => {
    const { db, records } = open()
    const before = repo.getTodaySummary(db, NOW).weekMinutes
    const lecture = db.select().from(t.lectures).all()[0]
    ses.addManualTime(
      db,
      records,
      {
        start: NOW.subtract({ minutes: 90 }).toString(),
        minutes: 45,
        link: { type: 'lecture', id: lecture.id },
        note: 'Reading'
      },
      NOW
    )
    expect(repo.getTodaySummary(db, NOW).weekMinutes).toBe(before + 45)
    const path = recordPath(db, records, { entityType: 'lecture', entityId: lecture.id })!
    expect(readFileSync(path, 'utf8')).toContain('45m · Manual time')
    expect(() =>
      ses.addManualTime(db, records, { start: NOW.toString(), minutes: 30, link: null }, NOW)
    ).toThrow(/future/)
  })
})
