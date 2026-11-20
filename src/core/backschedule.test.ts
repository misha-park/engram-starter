import { describe, expect, it } from 'vitest'
import type { AvailabilitySettings } from '../shared/types'
import { fromLegacy } from './availability'
import {
  backSchedule,
  chunkMinutes,
  lastFit,
  MAX_ASSIGNMENT_MINUTES_PER_DAY,
  type Interval
} from './scheduler'
import { localRange, toIso, zoned } from './time'

const av: AvailabilitySettings = fromLegacy({
  noWorkBefore: '09:00',
  workingHoursEnd: '22:00',
  protectedEvenings: [5],
  protectedEveningFrom: '18:00'
})
const at = (date: string, start: string, end: string): Interval => {
  const r = localRange(date, start, end)
  return { start: toIso(r.start), end: toIso(r.end) }
}
const minutes = (i: Interval) => (Date.parse(i.end) - Date.parse(i.start)) / 60000
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end

// Due Friday 4 Dec 2026, 12:00; "now" is Monday 16 Nov, 09:00.
const due = at('2026-12-04', '12:00', '13:00').start
const now = at('2026-11-16', '09:00', '10:00').start
const target = at('2026-12-02', '12:00', '13:00').start // 2 days before the deadline

describe('chunkMinutes', () => {
  it('splits into near-equal chunks of at most 90 minutes, in quarter hours', () => {
    expect(chunkMinutes(90)).toEqual([90])
    expect(chunkMinutes(300)).toEqual([75, 75, 75, 75])
    expect(chunkMinutes(0)).toEqual([])
    expect(chunkMinutes(180)).toEqual([90, 90])
    expect(chunkMinutes(240, 120)).toEqual([120, 120])
  })
})

it('lastFit returns the latest slot, snapped to quarter hours', () => {
  expect(
    lastFit(at('2026-11-16', '09:00', '18:10'), 60, [at('2026-11-16', '16:30', '18:10')])
  ).toEqual(at('2026-11-16', '15:30', '16:30'))
})

describe('backSchedule', () => {
  const stages = [
    { id: 'read', minutes: 240 },
    { id: 'draft', minutes: 300 },
    { id: 'edit', minutes: 120 }
  ]
  const run = (busy: Interval[] = [], s = stages, nowIso = now) =>
    backSchedule({ stages: s, due, now: nowIso, busy, availability: av })

  it('places everything, finishing at least 2 days before the deadline', () => {
    const { placements, unplaced } = run()
    expect(unplaced).toEqual([])
    expect(placements.reduce((sum, p) => sum + minutes(p), 0)).toBe(660)
    expect(placements.every((p) => p.end <= target && !p.inBuffer && p.withinAvailability)).toBe(
      true
    )
  })

  it('keeps stages in order', () => {
    const { placements } = run()
    const lastOf = (id: string) => placements.filter((p) => p.stageId === id).at(-1)!.end
    const firstOf = (id: string) => placements.filter((p) => p.stageId === id)[0].start
    expect(lastOf('read') <= firstOf('draft')).toBe(true)
    expect(lastOf('draft') <= firstOf('edit')).toBe(true)
  })

  it('works backwards: the last stage sits just before the target', () => {
    const { placements } = run()
    const last = placements.at(-1)!
    expect(last.stageId).toBe('edit')
    expect(zoned(last.end).toPlainDate().toString()).toBe('2026-12-02')
  })

  it('caps one assignment at 3 hours a day and never exceeds 90-minute blocks', () => {
    const { placements } = run()
    const perDay = new Map<string, number>()
    for (const p of placements) {
      expect(minutes(p)).toBeLessThanOrEqual(90)
      const d = zoned(p.start).toPlainDate().toString()
      perDay.set(d, (perDay.get(d) ?? 0) + minutes(p))
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(MAX_ASSIGNMENT_MINUTES_PER_DAY)
  })

  it('avoids busy time and respects availability', () => {
    const busy = [at('2026-12-02', '09:00', '12:00'), at('2026-12-01', '09:00', '22:00')]
    const { placements } = run(busy)
    for (const p of placements) {
      for (const b of busy) expect(overlaps(p, b)).toBe(false)
      const z = zoned(p.start)
      expect(z.hour).toBeGreaterThanOrEqual(9)
      if (z.dayOfWeek === 5)
        expect(zoned(p.end).hour * 60 + zoned(p.end).minute).toBeLessThanOrEqual(18 * 60)
    }
  })

  it('never places anything before now; uses the buffer when time is short', () => {
    // Now is the Tuesday before the deadline: not enough room before the target.
    const lateNow = at('2026-12-01', '09:00', '10:00').start
    const { placements, unplaced } = run([], [{ id: 'all', minutes: 600 }], lateNow)
    expect(placements.every((p) => p.start >= lateNow && p.end <= due)).toBe(true)
    expect(placements.some((p) => p.inBuffer)).toBe(true)
    expect(unplaced.length + placements.length).toBeGreaterThan(0)
  })

  it('reports what cannot be placed at all', () => {
    const lateNow = at('2026-12-04', '08:00', '09:00').start // deadline morning
    const { placements, unplaced } = run([], [{ id: 'all', minutes: 600 }], lateNow)
    const placed = placements.reduce((s, p) => s + minutes(p), 0)
    expect(placed + unplaced.reduce((s, u) => s + u.minutes, 0)).toBe(600)
    expect(unplaced[0]?.stageId).toBe('all')
  })

  it('is deterministic', () => {
    expect(run()).toEqual(run())
  })
})
