import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { termsBetween } from './terms'

const day = (s: string) => Temporal.PlainDate.from(s)

describe('UCL terms on a timeline', () => {
  it('keeps the terms and reading weeks in range, clipped to it', () => {
    const r = termsBetween(day('2026-11-18'), day('2027-03-01'))
    expect(r.terms.map((t) => [t.name, t.from.toString(), t.to.toString()])).toEqual([
      ['Term 1', '2026-11-18', '2026-12-18'],
      ['Term 2', '2027-01-11', '2027-03-01']
    ])
    expect(r.readingWeeks.map(String)).toEqual(['2027-02-15'])
    expect(termsBetween(day('2026-07-01'), day('2026-08-01')).terms).toEqual([])
  })
})
