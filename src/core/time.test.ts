import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import {
  formatClock,
  formatMinutes,
  localRange,
  minutesBetween,
  parseTimeInput,
  startOfWeek,
  toIso,
  weekRange
} from './time'

describe('startOfWeek', () => {
  it('returns Monday 00:00 London time', () => {
    // Wednesday 18 Nov 2026, 15:00 UTC (GMT)
    const monday = startOfWeek('2026-11-18T15:00:00Z')
    expect(monday.toPlainDate().toString()).toBe('2026-11-16')
    expect(toIso(monday)).toBe('2026-11-16T00:00:00Z')
  })

  it('treats Sunday as the last day of the week', () => {
    expect(startOfWeek('2026-11-22T22:00:00Z').toPlainDate().toString()).toBe('2026-11-16')
  })

  it('handles BST: Monday midnight is 23:00 UTC the day before', () => {
    expect(toIso(startOfWeek('2026-06-10T12:00:00Z'))).toBe('2026-06-07T23:00:00Z')
  })

  it('a week containing the clocks going forward is 167 hours long', () => {
    // BST starts Sunday 29 March 2026
    const { start, end } = weekRange('2026-03-25T12:00:00Z')
    expect(start.until(end).total({ unit: 'hours' })).toBe(167)
  })
})

describe('localRange', () => {
  it('rolls an end of 00:00 over to the next day (pub shift 17:00–00:00)', () => {
    const { start, end } = localRange('2026-11-21', '17:00', '00:00')
    expect(toIso(start)).toBe('2026-11-21T17:00:00Z')
    expect(toIso(end)).toBe('2026-11-22T00:00:00Z')
    expect(minutesBetween(toIso(start), toIso(end))).toBe(7 * 60)
  })

  it('uses local wall-clock time in summer', () => {
    const { start } = localRange('2026-07-04', '17:00', '00:00')
    expect(toIso(start)).toBe('2026-07-04T16:00:00Z')
    expect(formatClock(start.toInstant())).toBe('17:00')
  })
})

describe('formatMinutes', () => {
  it.each([
    [0, '0m'],
    [45, '45m'],
    [60, '1h'],
    [845, '14h 05m'],
    [-5, '0m']
  ])('%i → %s', (m, s) => expect(formatMinutes(m)).toBe(s))
})

it('Temporal polyfill is available', () => {
  expect(Temporal.PlainDate.from('2026-11-17').dayOfWeek).toBe(2)
})

describe('parseTimeInput', () => {
  it.each([
    ['9', '09:00'],
    ['930', '09:30'],
    ['0930', '09:30'],
    ['9:30', '09:30'],
    ['21.15', '21:15'],
    [' 7:05 ', '07:05'],
    ['24:00', null],
    ['9:75', null],
    ['nine', null]
  ])('%s → %s', (input, out) => expect(parseTimeInput(input)).toBe(out))
})
