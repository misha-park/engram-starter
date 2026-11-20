import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { estimateAccuracy, plannedVsActual, rangeStart, sumBy, weeklyTotals } from './stats'

const s = (start: string, minutes: number, categoryId: string | null, type = 'write-up') => ({
  start,
  minutes,
  categoryId,
  type
})

describe('stats sums', () => {
  it('totals by module and type, largest first, without empty entries', () => {
    const sessions = [
      s('2026-11-16T10:00:00Z', 60, 'phys'),
      s('2026-11-17T10:00:00Z', 90, 'neur'),
      s('2026-11-18T10:00:00Z', 30, 'phys', 'review'),
      s('2026-11-18T12:00:00Z', 0, null)
    ]
    expect(sumBy(sessions, (x) => x.categoryId)).toEqual([
      { key: 'phys', minutes: 90 },
      { key: 'neur', minutes: 90 }
    ])
    expect(sumBy(sessions, (x) => x.type)[0]).toEqual({ key: 'write-up', minutes: 150 })
  })

  it('totals by London week, Monday first, with empty weeks', () => {
    const weeks = weeklyTotals(
      // Sunday 23:30 in London (GMT) is still the week before.
      [s('2026-11-15T23:30:00Z', 45, null), s('2026-11-16T00:30:00Z', 30, null)],
      Temporal.PlainDate.from('2026-11-16'),
      3
    )
    expect(weeks).toEqual([
      { weekStart: '2026-11-02', minutes: 0 },
      { weekStart: '2026-11-09', minutes: 45 },
      { weekStart: '2026-11-16', minutes: 30 }
    ])
  })

  it('compares planned work with what was logged', () => {
    const p = plannedVsActual([
      { start: '2026-11-16T10:00:00Z', end: '2026-11-16T11:00:00Z', outcome: 'done', logged: 70 },
      {
        start: '2026-11-16T12:00:00Z',
        end: '2026-11-16T13:30:00Z',
        outcome: 'partial',
        logged: 40
      },
      { start: '2026-11-16T15:00:00Z', end: '2026-11-16T16:00:00Z', outcome: 'skipped', logged: 0 }
    ])
    expect(p).toEqual({
      plannedMinutes: 210,
      loggedMinutes: 110,
      blocks: 3,
      done: 1,
      partial: 1,
      skipped: 1,
      unmarked: 0
    })
  })

  it('measures estimates over stages with time logged', () => {
    const e = estimateAccuracy([
      { assignment: 'A', stage: 'Plan', estimate: 60, logged: 90 },
      { assignment: 'A', stage: 'Draft', estimate: 300, logged: 240 },
      { assignment: 'A', stage: 'Edit', estimate: 60, logged: 0 }
    ])
    expect(e.stages).toBe(2)
    expect(e.ratio).toBeCloseTo(330 / 360)
    expect(e.furthestOff[0]).toMatchObject({ stage: 'Plan', ratio: 1.5 })
    expect(estimateAccuracy([]).ratio).toBeNull()
  })

  it('starts ranges on Mondays', () => {
    const now = Temporal.Instant.from('2026-11-18T14:00:00Z')
    expect(rangeStart('week', now)?.toString()).toBe('2026-11-16')
    expect(rangeStart('4w', now)?.toString()).toBe('2026-10-26')
    expect(rangeStart('all', now)).toBeNull()
  })
})
