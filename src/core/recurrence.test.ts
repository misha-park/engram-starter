import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import type { RecurrenceRule } from '../shared/types'
import { describeRule, occurrenceDates, occurrenceRange } from './recurrence'
import { toIso } from './time'

const saturdays: RecurrenceRule = {
  freq: 'weekly',
  byWeekday: [6],
  startTime: '17:00',
  endTime: '00:00'
}
const d = (s: string) => Temporal.PlainDate.from(s)

describe('occurrenceDates', () => {
  it('lists every Saturday in range', () => {
    const dates = occurrenceDates(saturdays, {
      startsOn: '2026-11-01',
      from: d('2026-11-01'),
      to: d('2026-11-30')
    })
    expect(dates.map(String)).toEqual(['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'])
  })

  it('respects startsOn, until and removed occurrences', () => {
    const dates = occurrenceDates(saturdays, {
      startsOn: '2026-11-10',
      until: '2026-11-25',
      exdates: ['2026-11-14'],
      from: d('2026-11-01'),
      to: d('2026-11-30')
    })
    expect(dates.map(String)).toEqual(['2026-11-21'])
  })

  it('supports several weekdays', () => {
    const rule: RecurrenceRule = { ...saturdays, byWeekday: [1, 3] }
    const dates = occurrenceDates(rule, {
      startsOn: '2026-11-16',
      from: d('2026-11-16'),
      to: d('2026-11-22')
    })
    expect(dates.map(String)).toEqual(['2026-11-16', '2026-11-18'])
  })
})

describe('occurrenceRange', () => {
  it('runs a 17:00–00:00 shift to midnight, in local time across the clock change', () => {
    const winter = occurrenceRange(saturdays, '2026-11-21')
    expect([toIso(winter.start), toIso(winter.end)]).toEqual([
      '2026-11-21T17:00:00Z',
      '2026-11-22T00:00:00Z'
    ])
    const summer = occurrenceRange(saturdays, '2026-06-20')
    expect([toIso(summer.start), toIso(summer.end)]).toEqual([
      '2026-06-20T16:00:00Z',
      '2026-06-20T23:00:00Z'
    ])
  })
})

it('describeRule', () => {
  expect(describeRule(saturdays)).toBe('Saturdays 17:00–00:00')
})
