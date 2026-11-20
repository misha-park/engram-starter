import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { count } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { localRange, toIso, zoned } from '../core/time'
import { AppContext } from './app-context'
import * as t from './db/schema'
import * as repo from './repo'
import { seedDemo } from './seed'

const migrations = resolve(__dirname, '../../drizzle')
// Wednesday 18 Nov 2026, 14:00 London
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')

const open: AppContext[] = []
function context(at = NOW): AppContext {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-ctx-')), migrations, {
    clock: () => at
  })
  open.push(ctx)
  ctx.open()
  return ctx
}
afterEach(() => open.splice(0).forEach((c) => c.close()))

describe('demo profile', () => {
  it('is seeded automatically the first time it opens', () => {
    const ctx = context()
    expect(ctx.profile.name).toBe('demo')
    expect(existsSync(ctx.profile.dbPath)).toBe(true)
    expect(repo.listCategories(ctx.db)).toHaveLength(6)
    expect(repo.listModules(ctx.db)).toHaveLength(4)
  })

  it('merges the cross-listed project module (three names, plus the joined form the real feed uses)', () => {
    const proj = repo.listModules(context().db).find((m) => m.id === 'proj')!
    expect(proj.feedNames).toHaveLength(4)
  })

  it('reset regenerates identical data for the same clock', () => {
    const ctx = context()
    const before = ctx.db.select({ n: count() }).from(t.blocks).all()[0].n
    const summary = ctx.resetDemo()
    expect(summary.blocks).toBe(before)
    expect(ctx.db.select({ n: count() }).from(t.blocks).all()[0].n).toBe(before)
  })

  it('has past blocks in all three outcomes', () => {
    const outcomes = new Set(
      ctx()
        .db.select({ o: t.blocks.outcome })
        .from(t.blocks)
        .all()
        .map((r) => r.o)
    )
    expect([...outcomes].sort()).toEqual(['done', 'none', 'partial', 'skipped'])
  })

  it('has exactly one pending debrief and one timed-out timer awaiting a check-in', () => {
    const db = ctx().db
    const blocks = db.select().from(t.blocks).all()
    const sessions = db.select().from(t.sessions).all()
    const pending = blocks.filter((b) => b.debriefPending)
    expect(pending).toHaveLength(1)
    expect(pending[0].outcome).toBe('partial')
    const checkins = sessions.filter((s) => s.checkinPending)
    expect(checkins).toHaveLength(1)
    expect(blocks.find((b) => b.id === checkins[0].blockId)!.outcome).toBe('none')
  })

  it('only gives outcomes to blocks that have already ended', () => {
    for (const b of ctx().db.select().from(t.blocks).all()) {
      if (b.outcome !== 'none')
        expect(Temporal.Instant.compare(Temporal.Instant.from(b.end), NOW)).toBe(-1)
      expect(
        Temporal.Instant.compare(Temporal.Instant.from(b.start), Temporal.Instant.from(b.end))
      ).toBe(-1)
    }
  })

  it('places the pub shift on Saturdays 17:00–00:00 London time', () => {
    const shifts = ctx()
      .db.select()
      .from(t.blocks)
      .all()
      .filter((b) => b.type === 'pub-shift')
    expect(shifts.length).toBeGreaterThan(8)
    for (const s of shifts) {
      const start = zoned(s.start)
      expect(start.dayOfWeek).toBe(6)
      const expected = localRange(start.toPlainDate(), '17:00', '00:00')
      expect(s.start).toBe(toIso(expected.start))
      expect(s.end).toBe(toIso(expected.end))
    }
  })

  it('has overdue, recurring and done todos', () => {
    const todos = repo.listTodos(ctx().db)
    expect(todos.some((t) => t.dueDate !== null && t.dueDate < '2026-11-18' && !t.done)).toBe(true)
    expect(todos.some((t) => t.recurrence !== null)).toBe(true)
    expect(todos.some((t) => t.done)).toBe(true)
  })

  it('produces a non-zero weekly total and target', () => {
    const summary = repo.getTodaySummary(ctx().db, NOW)
    expect(summary.weekMinutes).toBeGreaterThan(0)
    expect(summary.weekTargetMinutes).toBe(1200)
    expect(summary.remainingTodayMinutes).toBeGreaterThan(0)
  })

  function ctx(): AppContext {
    return context()
  }
})

describe('real profile', () => {
  it('starts empty and is never seeded', () => {
    const c = context()
    c.switchProfile('real')
    expect(c.profile.name).toBe('real')
    expect(repo.listCategories(c.db)).toHaveLength(0)
  })

  it('refuses reset and seed', () => {
    const c = context()
    c.switchProfile('real')
    expect(() => c.resetDemo()).toThrow(/Refusing/)
    expect(() => seedDemo(c.db, c.profile, NOW)).toThrow(/Refusing/)
    expect(repo.listCategories(c.db)).toHaveLength(0)
  })

  it('switching back to demo finds the demo data untouched', () => {
    const c = context()
    const blocks = c.db.select({ n: count() }).from(t.blocks).all()[0].n
    c.switchProfile('real')
    c.switchProfile('demo')
    expect(c.db.select({ n: count() }).from(t.blocks).all()[0].n).toBe(blocks)
  })
})

it('demo dates follow the clock (the seed never goes stale)', () => {
  const later = NOW.add({ hours: 24 * 7 * 10 })
  const a = context().db.select().from(t.blocks).all()
  const b = context(later).db.select().from(t.blocks).all()
  expect(a.length).toBe(b.length)
  const shift = Temporal.Instant.from(b[0].start).since(Temporal.Instant.from(a[0].start))
  expect(Math.round(shift.total({ unit: 'days' }))).toBe(70)
})
