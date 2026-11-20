import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { zoned } from '../core/time'
import { AppContext } from './app-context'
import * as cal from './calendar'
import * as t from './db/schema'
import * as repo from './repo'
import { createDeadline } from './deadlines'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday

const contexts: AppContext[] = []
function db() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-cal-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const blocks = (d: ReturnType<typeof db>) => d.select().from(t.blocks).all()
const PUB = 'rec-pub-shift'

describe('moveBlock', () => {
  it('moves a flexible block, persists it and logs the change', () => {
    const d = db()
    const wu = blocks(d).find((b) => b.type === 'write-up' && b.start > '2026-11-19')!
    const moved = cal.moveBlock(d, wu.id, '2026-11-20T15:00:00Z', '2026-11-20T16:30:00Z')
    expect([moved.start, moved.end]).toEqual(['2026-11-20T15:00:00Z', '2026-11-20T16:30:00Z'])
    expect(cal.getBlock(d, wu.id)!.start).toBe('2026-11-20T15:00:00Z')
    const log = d
      .select()
      .from(t.changeLog)
      .all()
      .filter((l) => l.action === 'block.move')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ actor: 'user', action: 'block.move', entityId: wu.id })
  })

  it('normalises offsets to UTC', () => {
    const d = db()
    const wu = blocks(d).find((b) => b.type === 'write-up')!
    const moved = cal.moveBlock(d, wu.id, '2026-11-20T15:00:00+01:00', '2026-11-20T16:00:00+01:00')
    expect(moved.start).toBe('2026-11-20T14:00:00Z')
  })

  it('refuses to move timetabled events', () => {
    const d = db()
    const lecture = blocks(d).find((b) => b.type === 'lecture')!
    expect(() => cal.moveBlock(d, lecture.id, lecture.start, lecture.end)).toThrow(/timetable/i)
  })

  it('never lets automatic placement move a fixed event', () => {
    const d = db()
    const shift = blocks(d).find((b) => b.type === 'pub-shift')!
    expect(() => cal.moveBlock(d, shift.id, shift.start, shift.end, 'claude')).toThrow(
      /never moved/
    )
  })

  it('rejects an end before the start', () => {
    const d = db()
    const wu = blocks(d).find((b) => b.type === 'write-up')!
    expect(() => cal.moveBlock(d, wu.id, '2026-11-20T16:00:00Z', '2026-11-20T15:00:00Z')).toThrow(
      /end after/
    )
  })

  it('detaches a moved pub-shift occurrence from its series', () => {
    const d = db()
    const shift = blocks(d).find((b) => b.recurrenceId === PUB && b.start > '2026-11-19')!
    const moved = cal.moveBlock(d, shift.id, shift.start.replace('17:00', '18:00'), shift.end)
    expect(moved.detached).toBe(true)
  })
})

describe('recurring pub shift', () => {
  it('is materialised 12 weeks ahead with no duplicates', () => {
    const d = db()
    const shifts = blocks(d).filter((b) => b.recurrenceId === PUB)
    const dates = shifts.map((b) => b.occurrenceDate)
    expect(new Set(dates).size).toBe(dates.length)
    const last = dates.sort().at(-1)!
    expect(last >= '2027-02-06').toBe(true) // 12 weeks after 18 Nov 2026 → Sat 6 Feb 2027 or later
    expect(cal.ensureOccurrences(d, NOW)).toBe(0) // idempotent
  })

  it('a series edit moves future occurrences but keeps past and individually edited ones', () => {
    const d = db()
    const all = blocks(d).filter((b) => b.recurrenceId === PUB)
    const past = all.find((b) => b.end < '2026-11-18')!
    const edited = all
      .filter((b) => b.start > '2026-11-25')
      .sort((a, b) => a.start.localeCompare(b.start))[0]
    cal.moveBlock(d, edited.id, edited.start.replace('17:00', '16:00'), edited.end)

    cal.updateRecurrence(
      d,
      PUB,
      { freq: 'weekly', byWeekday: [5], startTime: '18:00', endTime: '23:30' },
      NOW
    )

    const after = blocks(d).filter((b) => b.recurrenceId === PUB)
    expect(after.find((b) => b.id === past.id)!.start).toBe(past.start)
    expect(after.find((b) => b.id === edited.id)!.start).toBe(
      edited.start.replace('17:00', '16:00')
    )
    // Nothing is back-filled into past weeks under the new rule.
    expect(
      after.filter((b) => b.end < '2026-11-18T14:00:00Z' && zoned(b.start).dayOfWeek === 5)
    ).toEqual([])
    const future = after.filter((b) => b.start > '2026-11-19' && !b.detached)
    expect(future.length).toBeGreaterThan(10)
    for (const b of future) {
      const z = zoned(b.start)
      expect(z.dayOfWeek).toBe(5)
      expect(`${z.hour}:${z.minute}`).toBe('18:0')
    }
  })

  it('removing one occurrence keeps it removed when the series is extended', () => {
    const d = db()
    const shift = blocks(d).find((b) => b.recurrenceId === PUB && b.start > '2026-11-19')!
    cal.removeOccurrence(d, shift.id)
    expect(cal.getBlock(d, shift.id)).toBeUndefined()
    cal.ensureOccurrences(d, NOW)
    expect(
      blocks(d).some((b) => b.recurrenceId === PUB && b.occurrenceDate === shift.occurrenceDate)
    ).toBe(false)
    expect(cal.getRecurrence(d, PUB)!.exdates).toContain(shift.occurrenceDate)
  })

  it('rejects an invalid rule', () => {
    const d = db()
    expect(() =>
      cal.updateRecurrence(
        d,
        PUB,
        { freq: 'weekly', byWeekday: [], startTime: '17:00', endTime: '00:00' },
        NOW
      )
    ).toThrow(/day/)
  })
})

describe('availability settings', () => {
  it('round-trips and validates', () => {
    const d = db()
    // The demo protects Friday evenings and starts later on Sundays.
    expect(cal.getAvailability(d).days[4]).toEqual({ start: '09:00', end: '18:00' })
    const days = [...cal.getAvailability(d).days]
    days[0] = { start: '08:30', end: '21:00' }
    days[5] = null
    const saved = cal.setAvailability(d, { days })
    expect(cal.getAvailability(d)).toEqual(saved)
    expect(cal.getAvailability(d).days[5]).toBeNull()
    days[1] = { start: '10:00', end: '07:00' }
    expect(() => cal.setAvailability(d, { days })).toThrow(/Tue/)
  })
})

it('lists the seeded deadlines', () => {
  const d = db()
  const deadlines = repo.listDeadlines(d, '2026-11-16T00:00:00Z', '2027-01-01T00:00:00Z')
  // Timetabled assessment and viva, the two assignments due in this window, and the
  // dissertation's next milestone (dated todos are tested in backlog.test.ts).
  expect(
    deadlines
      .filter((x) => x.kind !== 'todo')
      .map((x) => x.kind)
      .sort()
  ).toEqual(['assessment', 'assignment', 'assignment', 'dissertation', 'viva'])
  // Viva sessions are deadlines only: no calendar block.
  expect(d.select().from(t.blocks).where(eq(t.blocks.type, 'viva')).all()).toHaveLength(0)
})

describe('adding and deleting events by hand', () => {
  it('creates a fixed or flexible event, with a module’s colour, and deletes it again', () => {
    const d = db()
    const module = d.select().from(t.modules).all()[0]
    const fixed = cal.createBlock(d, {
      title: '  Dentist ',
      start: '2026-11-20T10:00:00Z',
      end: '2026-11-20T10:30:00Z',
      kind: 'fixed',
      moduleId: null
    })
    expect(fixed).toMatchObject({
      title: 'Dentist',
      kind: 'fixed',
      source: 'user',
      detached: true,
      categoryId: null
    })
    const study = cal.createBlock(d, {
      title: 'Revise L4',
      start: '2026-11-20T14:00:00Z',
      end: '2026-11-20T15:00:00Z',
      kind: 'flexible',
      moduleId: module.id
    })
    expect(study).toMatchObject({
      kind: 'flexible',
      categoryId: module.categoryId,
      linkedType: 'module'
    })
    cal.deleteBlock(d, fixed.id)
    expect(cal.getBlock(d, fixed.id)).toBeUndefined()
  })

  it('can be for an assignment (its next stage) or a deadline, taking its name when untitled', () => {
    const d = db()
    const a = d.select().from(t.assignments).all()[0]
    const stages = d
      .select()
      .from(t.assignmentStages)
      .where(eq(t.assignmentStages.assignmentId, a.id))
      .all()
      .sort((x, y) => x.position - y.position)
    const times = {
      start: '2026-11-20T10:00:00Z',
      end: '2026-11-20T13:00:00Z',
      kind: 'flexible' as const
    }
    const work = cal.createBlock(d, {
      ...times,
      title: '',
      moduleId: null,
      link: { type: 'assignment', id: a.id }
    })
    expect(work).toMatchObject({
      title: a.title,
      linkedType: 'assignment-stage',
      linkedId: stages.find((st) => !st.doneAt)!.id
    })
    expect(work.categoryId).not.toBeNull()
    const dl = createDeadline(d, {
      title: 'Ethics form',
      due: '2026-11-27T12:00:00Z',
      moduleId: null,
      notes: null
    })
    const forDeadline = cal.createBlock(d, {
      ...times,
      title: 'Fill it in',
      moduleId: null,
      link: { type: 'deadline', id: dl.id }
    })
    expect(forDeadline).toMatchObject({ linkedType: 'deadline', linkedId: dl.id })
    expect(repo.withDisplay(d, [forDeadline])[0]).toMatchObject({
      heading: 'Ethics form',
      detail: 'Fill it in'
    })
    // Edited with the stage it already has, it keeps it.
    const kept = cal.updateBlock(d, work.id, {
      ...times,
      title: 'Write methods',
      moduleId: null,
      link: { type: 'assignment-stage', id: work.linkedId! }
    })
    expect(kept.linkedId).toBe(work.linkedId)
    expect(repo.withDisplay(d, [kept])[0]).toMatchObject({
      heading: a.title,
      detail: 'Write methods'
    })
  })

  it('refuses bad input and won’t delete timetable or series blocks', () => {
    const d = db()
    const base = {
      title: 'X',
      start: '2026-11-20T10:00:00Z',
      end: '2026-11-20T10:00:00Z',
      kind: 'fixed' as const,
      moduleId: null
    }
    expect(() => cal.createBlock(d, base)).toThrow(/end after/)
    expect(() => cal.createBlock(d, { ...base, end: '2026-11-20T11:00:00Z', title: ' ' })).toThrow(
      /title/
    )
    const timetabled = d
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.source === 'timetable')!
    expect(() => cal.deleteBlock(d, timetabled.id)).toThrow(/Only events you added/)
    const occurrence = d
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.recurrenceId)!
    expect(() => cal.deleteBlock(d, occurrence.id)).toThrow(/series/)
  })
})

describe('editing an event added by hand', () => {
  it('changes its details, and refuses blocks that weren’t added by hand', () => {
    const d = db()
    const module = d.select().from(t.modules).all()[0]
    const b = cal.createBlock(d, {
      title: 'Dentist',
      start: '2026-11-20T10:00:00Z',
      end: '2026-11-20T10:30:00Z',
      kind: 'fixed',
      moduleId: null
    })
    const edited = cal.updateBlock(d, b.id, {
      title: 'Revise',
      start: '2026-11-21T14:00:00Z',
      end: '2026-11-21T16:00:00Z',
      kind: 'flexible',
      moduleId: module.id,
      notes: 'Bring the notes'
    })
    expect(edited).toMatchObject({
      title: 'Revise',
      start: '2026-11-21T14:00:00Z',
      kind: 'flexible',
      categoryId: module.categoryId,
      notes: 'Bring the notes',
      source: 'user'
    })
    const timetabled = blocks(d).find((x) => x.source === 'timetable')!
    expect(() =>
      cal.updateBlock(d, timetabled.id, {
        title: 'x',
        start: timetabled.start,
        end: timetabled.end,
        kind: 'fixed',
        moduleId: null
      })
    ).toThrow(/Only events you added/)
  })
})

describe('the outside-availability note', () => {
  it('goes when the block is moved somewhere free inside availability, stays otherwise', async () => {
    const d = db()
    const { freeSlots } = await import('./assistant/placement')
    const wu = blocks(d).find((b) => b.type === 'write-up' && b.start > '2026-11-19')!
    const note =
      'Placed outside your availability: no free time within 3 working days of the lecture.'
    d.update(t.blocks).set({ attention: note }).where(eq(t.blocks.id, wu.id)).run()
    const minutes = (Date.parse(wu.end) - Date.parse(wu.start)) / 60000

    // Into a clash: the note stays.
    const other = blocks(d).find(
      (b) => b.id !== wu.id && b.start > '2026-11-19' && b.kind === 'fixed' && b.type === 'lecture'
    )!
    const clashEnd = Temporal.Instant.from(other.start).add({ minutes }).toString()
    cal.moveBlock(d, wu.id, other.start, clashEnd)
    expect(cal.getBlock(d, wu.id)!.attention).toBe(note)

    // Into free time inside availability: it goes.
    const slot = freeSlots(d, { from: '2026-11-19', to: '2026-11-20', minutes }, NOW)[0].slots[0]
    const toUtc = (local: string) =>
      Temporal.PlainDateTime.from(local).toZonedDateTime('Europe/London').toInstant().toString()
    const start = toUtc(slot.start)
    cal.moveBlock(d, wu.id, start, Temporal.Instant.from(start).add({ minutes }).toString())
    expect(cal.getBlock(d, wu.id)!.attention).toBeNull()

    // Other notes (e.g. its lecture was removed) are never cleared by a move.
    d.update(t.blocks)
      .set({ attention: 'Its lecture was removed from the timetable.' })
      .where(eq(t.blocks.id, wu.id))
      .run()
    cal.moveBlock(d, wu.id, start, Temporal.Instant.from(start).add({ minutes }).toString())
    expect(cal.getBlock(d, wu.id)!.attention).toMatch(/removed/)
  })
})

describe('a repeating event added by hand', () => {
  it('becomes a weekly series from its date, on the chosen days, until a date', () => {
    const d = db()
    // Monday 16 Nov (before NOW, a Wednesday) 18:00–19:30, Mondays and Thursdays, to 3 Dec.
    const first = cal.createRecurringEvent(
      d,
      {
        title: 'Climbing',
        start: '2026-11-16T18:00:00Z',
        end: '2026-11-16T19:30:00Z',
        kind: 'fixed',
        moduleId: null,
        repeat: { byWeekday: [1, 4], until: '2026-12-03' }
      },
      'user',
      NOW
    )
    expect(first.start).toBe('2026-11-16T18:00:00Z')
    expect(first.recurrenceId).toBeTruthy()
    const dates = blocks(d)
      .filter((b) => b.recurrenceId === first.recurrenceId)
      .map((b) => b.occurrenceDate)
      .sort()
    expect(dates).toEqual([
      '2026-11-16',
      '2026-11-19',
      '2026-11-23',
      '2026-11-26',
      '2026-11-30',
      '2026-12-03'
    ])
    // No days given: the event's own weekday, for good.
    const weekly = cal.createBlock(d, {
      title: 'Lab meeting',
      start: '2026-11-20T09:00:00Z',
      end: '2026-11-20T10:00:00Z',
      kind: 'fixed',
      moduleId: null,
      repeat: { byWeekday: [], until: null }
    })
    expect(cal.getRecurrence(d, weekly.recurrenceId!)!.rule.byWeekday).toEqual([5])
    expect(() =>
      cal.createRecurringEvent(d, {
        title: 'Bad',
        start: '2026-11-20T09:00:00Z',
        end: '2026-11-20T10:00:00Z',
        kind: 'fixed',
        moduleId: null,
        repeat: { byWeekday: [5], until: '2026-11-01' }
      })
    ).toThrow(/before it starts/)
  })
})

describe('stopping a series', () => {
  it('ends it after an occurrence, keeping anything touched by hand', () => {
    const d = db()
    const first = cal.createRecurringEvent(
      d,
      {
        title: 'Lab meeting',
        start: '2026-11-20T09:00:00Z',
        end: '2026-11-20T10:00:00Z',
        kind: 'fixed',
        moduleId: null,
        repeat: { byWeekday: [5], until: null }
      },
      'user',
      NOW
    )
    const series = () =>
      blocks(d)
        .filter((b) => b.recurrenceId === first.recurrenceId)
        .sort((a, b) => a.start.localeCompare(b.start))
    const [, second, third, fourth] = series()
    // You moved the fourth by hand: it stays.
    cal.moveBlock(d, fourth.id, '2026-12-11T11:00:00Z', '2026-12-11T12:00:00Z', 'user')
    cal.endSeriesAfter(d, second.id)
    const left = series().map((b) => b.occurrenceDate)
    expect(left).toContain(second.occurrenceDate)
    expect(left).not.toContain(third.occurrenceDate)
    expect(left).toContain(fourth.occurrenceDate)
    expect(cal.getRecurrence(d, first.recurrenceId!)!.until).toBe(second.occurrenceDate)
    // Later regeneration doesn't bring them back.
    cal.ensureOccurrences(d, NOW)
    expect(series().map((b) => b.occurrenceDate)).toEqual(left)
  })
})
