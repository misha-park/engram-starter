// UCL term dates, for a sense of time on the dissertation timeline. From UCL's published
// "Term dates and closures" (some programmes, e.g. the Medical School, keep their own).
// Add each new academic year here when UCL publishes it.

import { Temporal } from 'temporal-polyfill'

export interface Term {
  name: string
  /** Local dates YYYY-MM-DD, first and last day. */
  start: string
  end: string
}

export const UCL_TERMS: Term[] = [
  { name: 'Term 1', start: '2026-09-28', end: '2026-12-18' },
  { name: 'Term 2', start: '2027-01-11', end: '2027-03-24' },
  { name: 'Term 3', start: '2027-04-26', end: '2027-06-11' }
]

/** Mondays of UCL's reading weeks. */
export const UCL_READING_WEEKS: string[] = ['2026-11-09', '2027-02-15']

/** The terms and reading weeks that fall (at least partly) between two dates, clipped to them. */
export function termsBetween(
  from: Temporal.PlainDate,
  to: Temporal.PlainDate
): {
  terms: (Term & { from: Temporal.PlainDate; to: Temporal.PlainDate })[]
  readingWeeks: Temporal.PlainDate[]
} {
  const cmp = Temporal.PlainDate.compare
  const max = (a: Temporal.PlainDate, b: Temporal.PlainDate) => (cmp(a, b) > 0 ? a : b)
  const min = (a: Temporal.PlainDate, b: Temporal.PlainDate) => (cmp(a, b) < 0 ? a : b)
  return {
    terms: UCL_TERMS.flatMap((t) => {
      const s = Temporal.PlainDate.from(t.start)
      const e = Temporal.PlainDate.from(t.end)
      if (cmp(e, from) < 0 || cmp(s, to) > 0) return []
      return [{ ...t, from: max(s, from), to: min(e, to) }]
    }),
    readingWeeks: UCL_READING_WEEKS.map((d) => Temporal.PlainDate.from(d)).filter(
      (d) => cmp(d, from) >= 0 && cmp(d, to) <= 0
    )
  }
}
