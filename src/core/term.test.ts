import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { termTwoEnd, termTwoYear } from './term'

const d = (s: string) => Temporal.PlainDate.from(s)
// Weekly lectures: term 1 (Oct–Dec), term 2 (Jan–Mar, Easter gap, then two more in late Apr).
const lectures = [
  ...[0, 7, 14, 21, 28, 35, 42, 49].map((n) => d('2026-10-05').add({ days: n })),
  ...[0, 7, 14, 21, 28, 35, 42, 49, 56].map((n) => d('2027-01-11').add({ days: n })),
  d('2027-04-26'),
  d('2027-05-03')
]

describe('term 2 end', () => {
  it('belongs to the next calendar year from September', () => {
    expect(termTwoYear(d('2026-11-18'))).toBe(2027)
    expect(termTwoYear(d('2027-05-01'))).toBe(2027)
  })

  it('is hidden during the year and through the Easter gap', () => {
    expect(termTwoEnd(lectures, d('2026-11-18'))).toBeNull()
    expect(termTwoEnd(lectures, d('2027-04-10'))).toBeNull() // Easter: more lectures follow
    expect(termTwoEnd(lectures, d('2027-05-10'))).toBeNull() // only 7 days after the last
  })

  it('appears 14 lecture-free days after the last lecture', () => {
    expect(termTwoEnd(lectures, d('2027-05-17'))?.toString()).toBe('2027-05-03')
    expect(termTwoEnd(lectures, d('2027-08-20'))?.toString()).toBe('2027-05-03')
  })

  it('needs term 2 lectures in the timetable', () => {
    expect(termTwoEnd(lectures.slice(0, 8), d('2027-06-30'))).toBeNull()
  })
})
