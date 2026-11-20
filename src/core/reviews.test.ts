import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { intervalBefore, nextDue, REVIEW_STEPS, reviewStatus } from './reviews'

describe('review intervals', () => {
  it('follows +1, +3, +7, +21, +60 days for "ok"', () => {
    expect([1, 2, 3, 4, 5].map((s) => intervalBefore(s, 'ok'))).toEqual([1, 3, 7, 21, 60])
    expect(intervalBefore(REVIEW_STEPS + 1, 'ok')).toBeNull()
  })

  it('stretches after easy and shortens after hard, never below a day', () => {
    expect(intervalBefore(3, 'easy')).toBe(11) // 7 × 1.5 → 10.5 → 11
    expect(intervalBefore(3, 'hard')).toBe(4) // 7 × 0.5 → 3.5 → 4
    expect(intervalBefore(2, 'hard')).toBe(2)
    expect(intervalBefore(1, 'easy')).toBe(1) // the first one is fixed
    expect(intervalBefore(2, null)).toBe(3) // unrated counts as ok
  })

  it('gives due dates and statuses', () => {
    const d = Temporal.PlainDate.from('2026-11-18')
    expect(nextDue(d, 1, null)?.toString()).toBe('2026-11-19')
    expect(reviewStatus('2026-11-17', null, d)).toBe('overdue')
    expect(reviewStatus('2026-11-18', null, d)).toBe('today')
    expect(reviewStatus('2026-11-19', null, d)).toBe('upcoming')
    expect(reviewStatus('2026-11-17', '2026-11-17T18:00:00Z', d)).toBe('done')
  })
})
