import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import type { AvailabilitySettings } from '../shared/types'
import {
  availableWindow,
  dayWindow,
  describeAvailability,
  fromLegacy,
  noWorkBefore,
  normalizeAvailability,
  toBusinessHours,
  validateAvailability
} from './availability'
import { toIso } from './time'

const legacy = {
  noWorkBefore: '09:00',
  workingHoursEnd: '22:00',
  protectedEvenings: [5],
  protectedEveningFrom: '18:00'
}
const av: AvailabilitySettings = fromLegacy(legacy)

describe('dayWindow', () => {
  it('uses the working day normally', () => {
    expect(dayWindow(av, 1)).toEqual({ start: '09:00', end: '22:00' })
  })
  it('ends at the protected-evening time on protected days', () => {
    expect(dayWindow(av, 5)).toEqual({ start: '09:00', end: '18:00' })
  })
  it('returns null when nothing is left', () => {
    expect(dayWindow(fromLegacy({ ...legacy, protectedEveningFrom: '08:00' }), 5)).toBeNull()
  })
})

it('availableWindow resolves local times on a date', () => {
  const w = availableWindow(av, Temporal.PlainDate.from('2026-07-03'))! // a Friday in BST
  expect([toIso(w.start), toIso(w.end)]).toEqual(['2026-07-03T08:00:00Z', '2026-07-03T17:00:00Z'])
})

it('toBusinessHours groups days with the same hours (FullCalendar uses 0 = Sunday)', () => {
  expect(toBusinessHours(av)).toEqual([
    { daysOfWeek: [1, 2, 3, 4, 6, 0], startTime: '09:00', endTime: '22:00' },
    { daysOfWeek: [5], startTime: '09:00', endTime: '18:00' }
  ])
})

describe('validateAvailability', () => {
  it('accepts valid settings', () => expect(validateAvailability(av)).toBeNull())
  it('rejects bad times', () =>
    expect(
      validateAvailability({
        days: av.days.map((d, i) => (i === 0 ? { start: '9am', end: '22:00' } : d))
      })
    ).toMatch(/Invalid/))
})

describe('per-day hours', () => {
  it('reads the old settings shape and the new one', () => {
    expect(normalizeAvailability(legacy)).toEqual(av)
    expect(normalizeAvailability(null).days.every((d) => d?.start === '09:00')).toBe(true)
    expect(normalizeAvailability(av)).toEqual(av)
  })

  it('has its own hours each day, and days off', () => {
    const days = [...av.days]
    days[6] = null // Sunday off
    days[0] = { start: '10:00', end: '16:00' }
    const custom = { days }
    expect(dayWindow(custom, 1)).toEqual({ start: '10:00', end: '16:00' })
    expect(dayWindow(custom, 7)).toBeNull()
    // A day off falls back to the earliest start for the "no work before" limit.
    expect(noWorkBefore(custom, 7)).toBe('09:00')
    expect(describeAvailability(custom)).toBe(
      'Mon 10:00–16:00, Tue–Thu 09:00–22:00, Fri 09:00–18:00, Sat 09:00–22:00, Sun off'
    )
  })

  it('rejects a day that ends before it starts', () => {
    const days = [...av.days]
    days[2] = { start: '18:00', end: '09:00' }
    expect(validateAvailability({ days })).toMatch(/Wed/)
  })
})
