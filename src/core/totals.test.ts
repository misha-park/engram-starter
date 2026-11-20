import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { overlapMinutes, remainingTodayMinutes, weekStudyMinutes } from './totals'

const now = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00 London

describe('weekStudyMinutes', () => {
  it('sums sessions inside the Monday–Sunday week and clips ones that straddle it', () => {
    const sessions = [
      { start: '2026-11-16T10:00:00Z', end: '2026-11-16T11:30:00Z' }, // 90, Monday
      { start: '2026-11-15T23:30:00Z', end: '2026-11-16T00:30:00Z' }, // 30 of 60 in this week
      { start: '2026-11-13T10:00:00Z', end: '2026-11-13T12:00:00Z' } // last week
    ]
    expect(weekStudyMinutes(sessions, now)).toBe(120)
  })

  it('counts a running session up to now', () => {
    expect(weekStudyMinutes([{ start: '2026-11-18T13:15:00Z', end: null }], now)).toBe(45)
  })
})

describe('remainingTodayMinutes', () => {
  const block = (
    start: string,
    end: string,
    extra: Partial<{ kind: 'fixed' | 'flexible'; outcome: string }> = {}
  ) => ({
    start,
    end,
    kind: 'flexible' as const,
    outcome: 'none',
    ...extra
  })

  it('counts only the part of unfinished flexible blocks still ahead today', () => {
    const blocks = [
      block('2026-11-18T13:30:00Z', '2026-11-18T15:00:00Z'), // 60 left
      block('2026-11-18T17:00:00Z', '2026-11-18T18:30:00Z'), // 90
      block('2026-11-18T16:00:00Z', '2026-11-18T17:00:00Z', { kind: 'fixed' }), // fixed: ignored
      block('2026-11-18T19:00:00Z', '2026-11-18T20:00:00Z', { outcome: 'done' }), // finished: ignored
      block('2026-11-18T09:00:00Z', '2026-11-18T10:00:00Z') // already over
    ]
    expect(remainingTodayMinutes(blocks, now)).toBe(150)
  })
})

it('overlapMinutes returns 0 for disjoint ranges', () => {
  expect(
    overlapMinutes(
      { start: '2026-11-18T10:00:00Z', end: '2026-11-18T11:00:00Z' },
      Temporal.Instant.from('2026-11-18T12:00:00Z'),
      Temporal.Instant.from('2026-11-18T13:00:00Z'),
      now
    )
  ).toBe(0)
})
